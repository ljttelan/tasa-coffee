import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import benguetArabicaPhoto from './assets/products/benguet-arabica.webp'
import barakoDarkRoastPhoto from './assets/products/barako-dark-roast.webp'
import sagadaLightRoastPhoto from './assets/products/sagada-light-roast.webp'
import icedSpanishLattePhoto from './assets/products/iced-spanish-latte.webp'
import calamansiColdBrewPhoto from './assets/products/calamansi-cold-brew.webp'
import ubeLattePhoto from './assets/products/ube-latte.webp'
import ensaymadaPhoto from './assets/products/ensaymada.webp'
import tasaTumblerPhoto from './assets/products/tasa-tumbler.webp'
import { supabase } from './lib/supabase'
import type {
  Category,
  CustomerAddress,
  Json,
  Order,
  OrderItem,
  OrderStatus,
  Product,
  ProductCategory,
  ProductVariant,
  Profile,
  Role,
  StoreEvent,
  TrackedOrder,
} from './lib/database.types'
import './App.css'

type Page = 'shop' | 'cart' | 'checkout' | 'account' | 'staff' | 'track'
type StaffTab = 'Orders' | 'Inventory' | 'Customers' | 'Reports'
type AccountTab = 'Overview' | 'Orders' | 'Profile details'
type AccountOrderFilter = 'All orders' | 'In progress' | 'Delivered'
type ProductSort = 'relevance' | 'low' | 'high' | 'popularity'
type ProductPriceRange = 'all' | 'under-100' | '100-150' | 'above-150'
type CartLine = { productId: string; option: string; quantity: number }
type CartEntry = CartLine & { product: Product; unitPrice: number }
type ProductDraft = Pick<Product, 'name' | 'category' | 'description' | 'price' | 'stock' | 'image_url'>
type OrderView = Order & { items: OrderItem[]; customerEmail?: string }
type CustomerView = Profile & { orderCount: number }
type CourierView = Pick<Profile, 'id' | 'name' | 'email'>

const initialCategories: Category[] = ['Beans', 'Brewed', 'Pastries', 'Merch']
const productPhotos: Record<string, string> = {
  'Benguet Arabica Beans': benguetArabicaPhoto,
  'Barako Dark Roast': barakoDarkRoastPhoto,
  'Sagada Light Roast': sagadaLightRoastPhoto,
  'Iced Spanish Latte': icedSpanishLattePhoto,
  'Calamansi Cold Brew': calamansiColdBrewPhoto,
  'Ube Latte': ubeLattePhoto,
  Ensaymada: ensaymadaPhoto,
  'Tasa Tumbler': tasaTumblerPhoto,
}
const categoryPhotos: Record<Category, string> = {
  Beans: barakoDarkRoastPhoto,
  Brewed: icedSpanishLattePhoto,
  Pastries: ensaymadaPhoto,
  Merch: tasaTumblerPhoto,
}
const money = (amount: number) =>
  new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(amount)
const formatOrderNumber = (id: string) => `TASA-${id.replace(/-/g, '').toUpperCase()}`
const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'The request could not be completed.'

function readVisitorId(): { id: string; error: string } {
  const key = 'tasa-analytics-session'
  try {
    const existing = window.sessionStorage.getItem(key)
    if (existing) return { id: existing, error: '' }
    const id = crypto.randomUUID()
    window.sessionStorage.setItem(key, id)
    return { id, error: '' }
  } catch (reason) {
    return { id: crypto.randomUUID(), error: `Could not persist analytics session: ${getErrorMessage(reason)}` }
  }
}

function readInitialCart(): { cart: CartLine[]; error: string } {
  try {
    const saved = window.localStorage.getItem('tasa-cart')
    if (!saved) return { cart: [], error: '' }
    const parsed: unknown = JSON.parse(saved)
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (line) =>
          typeof line?.productId !== 'string' ||
          typeof line?.option !== 'string' ||
          !Number.isInteger(line?.quantity) ||
          line.quantity < 1,
      )
    ) {
      throw new Error('Saved cart data is invalid.')
    }
    return { cart: parsed as CartLine[], error: '' }
  } catch (reason) {
    return { cart: [], error: `Could not restore the saved cart: ${getErrorMessage(reason)}` }
  }
}

function nextStatuses(status: OrderStatus): OrderStatus[] {
  const transitions: Record<OrderStatus, OrderStatus[]> = {
    Pending: ['Packing', 'Cancelled'],
    Packing: ['Out for delivery', 'Cancelled'],
    'Out for delivery': ['Delivered', 'Cancelled'],
    Delivered: [],
    Cancelled: [],
    Returned: [],
  }
  return transitions[status]
}

function defaultVariantLines(category: Category): string {
  if (category === 'Beans') return 'Whole bean|0\nEspresso grind|0\nFilter grind|0'
  if (category === 'Brewed') return 'Regular|0\nLarge (+₱30)|30'
  return 'Standard|0'
}

function App() {
  const [storedCart] = useState(readInitialCart)
  const [visitor] = useState(readVisitorId)
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [page, setPage] = useState<Page>('shop')
  const [shopNavTarget, setShopNavTarget] = useState<'home' | 'menu'>('home')
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login')
  const [staffTab, setStaffTab] = useState<StaffTab>('Orders')
  const [accountTab, setAccountTab] = useState<AccountTab>('Overview')
  const [accountOrderFilter, setAccountOrderFilter] = useState<AccountOrderFilter>('All orders')
  const [trackingNumber, setTrackingNumber] = useState('')
  const [trackedOrder, setTrackedOrder] = useState<TrackedOrder | null>(null)
  const [trackingError, setTrackingError] = useState('')
  const [trackingBusy, setTrackingBusy] = useState(false)
  const [trackingDialogOrderId, setTrackingDialogOrderId] = useState<string | null>(null)
  const [trackingDialogDetails, setTrackingDialogDetails] = useState<TrackedOrder | null>(null)
  const [trackingDialogError, setTrackingDialogError] = useState('')
  const [trackingDialogLoading, setTrackingDialogLoading] = useState(false)
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<ProductCategory[]>(
    initialCategories.map((name) => ({ name, active: true, created_at: '' })),
  )
  const [variants, setVariants] = useState<ProductVariant[]>([])
  const [orders, setOrders] = useState<OrderView[]>([])
  const [customers, setCustomers] = useState<CustomerView[]>([])
  const [couriers, setCouriers] = useState<CourierView[]>([])
  const [addresses, setAddresses] = useState<CustomerAddress[]>([])
  const [shippingAddress, setShippingAddress] = useState('')
  const [storeEvents, setStoreEvents] = useState<StoreEvent[]>([])
  const [cart, setCart] = useState<CartLine[]>(storedCart.cart)
  const [quickAddProduct, setQuickAddProduct] = useState<Product | null>(null)
  const [quickAddOption, setQuickAddOption] = useState('')
  const [quickAddQuantity, setQuickAddQuantity] = useState(1)
  const quickAddDialog = useRef<HTMLDialogElement>(null)
  const loginDialog = useRef<HTMLDialogElement>(null)
  const trackingDialog = useRef<HTMLDialogElement>(null)
  const trackingDialogRequest = useRef(0)
  const pendingLoginAdd = useRef(false)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<'All' | Category>('All')
  const [sort, setSort] = useState<ProductSort>('relevance')
  const [priceRange, setPriceRange] = useState<ProductPriceRange>('all')
  const [productPopularity, setProductPopularity] = useState<Record<string, number>>({})
  const [popularityError, setPopularityError] = useState('')
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [couponInput, setCouponInput] = useState('')
  const [appliedCoupon, setAppliedCoupon] = useState('')
  const [couponDiscount, setCouponDiscount] = useState(0)
  const checkoutStarted = useRef(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState(
    supabase
      ? storedCart.error || visitor.error
      : 'Add the Supabase URL and publishable key in frontend/.env.local to connect this app.',
  )
  const [loading, setLoading] = useState(Boolean(supabase))
  const [busy, setBusy] = useState(false)
  const cartCount = cart.reduce((total, item) => total + item.quantity, 0)

  const showError = (reason: unknown) => {
    setError(getErrorMessage(reason))
    setNotice('')
  }

  const saveCart = (nextCart: CartLine[]) => {
    setCart(nextCart)
    try {
      window.localStorage.setItem('tasa-cart', JSON.stringify(nextCart))
    } catch (reason) {
      setError(`Could not save your cart: ${getErrorMessage(reason)}`)
      setNotice('')
    }
  }

  const runAction = async (action: () => Promise<void>, successMessage: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      setNotice(successMessage)
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(false)
    }
  }

  const refreshProductPopularity = useCallback(async () => {
    if (!supabase) return
    try {
      const { data, error: requestError } = await supabase.rpc('get_product_popularity')
      if (requestError) throw requestError
      setProductPopularity(
        Object.fromEntries((data ?? []).map((item) => [item.product_id, Number(item.popularity)])),
      )
      setPopularityError('')
    } catch (reason) {
      setPopularityError(getErrorMessage(reason))
    }
  }, [])

  const trackEvent = useCallback(async (
    eventType: StoreEvent['event_type'],
    productId: string | null = null,
  ) => {
    const client = supabase
    if (!client) return
    const { error: requestError } = await client.from('store_events').insert({
      visitor_id: visitor.id,
      user_id: session?.user.id ?? null,
      event_type: eventType,
      product_id: productId,
    })
    if (requestError) throw new Error(`Analytics event could not be recorded: ${getErrorMessage(requestError)}`)
  }, [visitor.id, session?.user.id])

  const navigateTo = (nextPage: Page) => {
    if (nextPage !== page) {
      if (nextPage === 'shop') {
        void trackEvent('catalog_view').catch(showError)
      }
      if (nextPage === 'checkout' && cartCount > 0) {
        checkoutStarted.current = true
        void trackEvent('checkout_started').catch(showError)
      } else if (page === 'checkout' && checkoutStarted.current && cartCount > 0) {
        checkoutStarted.current = false
        void trackEvent('order_abandoned').catch(showError)
      }
    }
    setPage(nextPage)
  }

  const navigateToMenu = () => {
    setShopNavTarget('menu')
    void refreshProductPopularity()
    navigateTo('shop')
  }

  const openOrders = (filter: AccountOrderFilter) => {
    setAccountTab('Orders')
    setAccountOrderFilter(filter)
    if (!session) setAuthMode('login')
    navigateTo('account')
  }

  const findOrder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setTrackingError('')
    setTrackedOrder(null)

    const orderNumber = trackingNumber.trim()
    const compactNumber = orderNumber.replace(/^TASA-/i, '').replace(/-/g, '')
    if (!/^[0-9a-f]{32}$/i.test(compactNumber)) {
      setTrackingError('Enter the complete Tasa order number from your confirmation email.')
      return
    }

    const client = supabase
    if (!client) {
      setTrackingError('Order tracking is unavailable until the store is connected to Supabase.')
      return
    }

    setTrackingBusy(true)
    try {
      const { data, error: requestError } = await client.rpc('track_order', {
        p_order_number: `TASA-${compactNumber.toUpperCase()}`,
      })
      if (requestError) throw requestError
      const foundOrder = data?.[0]
      if (!foundOrder) {
        setTrackingError('We couldn’t find that order. Check the number and try again.')
        return
      }
      setTrackedOrder(foundOrder)
    } catch (reason) {
      setTrackingError(getErrorMessage(reason))
    } finally {
      setTrackingBusy(false)
    }
  }

  const openTrackingDialog = async (order: OrderView) => {
    const requestId = ++trackingDialogRequest.current
    const client = supabase
    setTrackingDialogOrderId(order.id)
    setTrackingDialogDetails(null)
    setTrackingDialogError('')
    setTrackingDialogLoading(Boolean(client))
    setError('')
    setNotice('')
    trackingDialog.current?.showModal()

    if (!client) {
      setTrackingDialogError('Order tracking is unavailable until the store is connected to Supabase.')
      return
    }

    try {
      const { data, error: requestError } = await client.rpc('track_order', {
        p_order_number: formatOrderNumber(order.id),
      })
      if (requestError) throw requestError
      if (requestId !== trackingDialogRequest.current) return
      const details = data?.[0]
      if (!details) {
        setTrackingDialogError('We could not load tracking details for this order.')
        return
      }
      setTrackingDialogDetails(details)
    } catch (reason) {
      if (requestId === trackingDialogRequest.current) {
        setTrackingDialogError(getErrorMessage(reason))
      }
    } finally {
      if (requestId === trackingDialogRequest.current) {
        setTrackingDialogLoading(false)
      }
    }
  }

  useEffect(() => {
    void trackEvent('catalog_view').catch((reason) => {
      console.error('Analytics event could not be recorded:', reason)
    })
  }, [trackEvent])

  const loadProfile = async (userId: string) => {
    if (!supabase) return
    const { data, error: requestError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle()
    if (requestError) throw requestError
    setProfile(data)
  }

  useEffect(() => {
    if (!supabase) return

    let active = true
    const applySession = async (nextSession: Session | null) => {
      if (!active) return
      setSession(nextSession)
      if (!nextSession) {
        setProfile(null)
        setOrders([])
        setCustomers([])
        setCouriers([])
        setAddresses([])
        setShippingAddress('')
        setStoreEvents([])
        checkoutStarted.current = false
        setLoading(false)
        return
      }
      try {
        await loadProfile(nextSession.user.id)
      } catch (reason) {
        if (active) showError(reason)
      } finally {
        if (active) setLoading(false)
      }
    }

    void supabase.auth.getSession().then(({ data, error: requestError }) => {
      if (requestError) showError(requestError)
      if (data.session) setPage('shop')
      void applySession(data.session)
    })
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      window.setTimeout(() => void applySession(nextSession), 0)
    })
    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!session || !pendingLoginAdd.current || !quickAddProduct) return
    loginDialog.current?.close()
    pendingLoginAdd.current = false
    quickAddDialog.current?.showModal()
  }, [session, quickAddProduct])

  useEffect(() => {
    if (!supabase) return
    let active = true
    void supabase
      .from('product_categories')
      .select('*')
      .order('name')
      .then(({ data, error: requestError }) => {
        if (!active) return
        if (requestError) showError(requestError)
        else if (data?.length) setCategories(data)
      })
    return () => {
      active = false
    }
  }, [profile?.role])

  useEffect(() => {
    if (!supabase) return
    let active = true
    void supabase
      .from('product_variants')
      .select('*')
      .order('sort_order')
      .then(({ data, error: requestError }) => {
        if (!active) return
        if (requestError) showError(requestError)
        else setVariants(data ?? [])
      })
    return () => {
      active = false
    }
  }, [profile?.role])

  useEffect(() => {
    if (!supabase) return
    let active = true
    void supabase
      .from('products')
      .select('*')
      .order('name')
      .then(({ data, error: requestError }) => {
        if (!active) return
        if (requestError) showError(requestError)
        else setProducts(data ?? [])
      })
    return () => {
      active = false
    }
  }, [profile?.role])

  useEffect(() => {
    const client = supabase
    const userId = profile?.id
    if (!client || !userId || (page !== 'account' && page !== 'checkout')) return
    let active = true
    void client
      .from('customer_addresses')
      .select('*')
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false })
      .then(({ data, error: requestError }) => {
        if (!active) return
        if (requestError) showError(requestError)
        else {
          const savedAddresses = data ?? []
          setAddresses(savedAddresses)
          setShippingAddress((current) =>
            current || (savedAddresses.find((address) => address.is_default) ?? savedAddresses[0])?.full_address || '',
          )
        }
      })
    return () => {
      active = false
    }
  }, [profile?.id, page])

  const cartEntries = useMemo<CartEntry[]>(
    () =>
      cart.flatMap((line) => {
        const product = products.find((candidate) => candidate.id === line.productId)
        const variant = variants.find(
          (candidate) =>
            candidate.product_id === line.productId &&
            candidate.name === line.option &&
            candidate.active,
        )
        return product && variant
          ? [{ ...line, product, unitPrice: Number(product.price) + Number(variant.price_delta) }]
          : []
      }),
    [cart, products, variants],
  )
  const subtotal = cartEntries.reduce((total, item) => total + item.unitPrice * item.quantity, 0)
  const deliveryFee = subtotal === 0 || subtotal >= 1000 ? 0 : 60
  const total = Math.max(0, subtotal - couponDiscount) + deliveryFee
  const quickAddRemaining = quickAddProduct
    ? Math.max(
        0,
        quickAddProduct.stock -
          cart
            .filter((line) => line.productId === quickAddProduct.id)
            .reduce((count, line) => count + line.quantity, 0),
      )
    : 0
  const quickAddVariants = quickAddProduct
    ? variants
      .filter((variant) => variant.product_id === quickAddProduct.id && variant.active)
      .sort((left, right) => left.sort_order - right.sort_order)
    : []
  const quickAddVariant = quickAddVariants.find((variant) => variant.name === quickAddOption)
  const quickAddUnitPrice = quickAddProduct
    ? Number(quickAddProduct.price) + Number(quickAddVariant?.price_delta ?? 0)
    : 0

  const refreshProducts = async () => {
    if (!supabase) return
    const [productResult, variantResult] = await Promise.all([
      supabase.from('products').select('*').order('name'),
      supabase.from('product_variants').select('*').order('sort_order'),
    ])
    if (productResult.error) throw productResult.error
    if (variantResult.error) throw variantResult.error
    setProducts(productResult.data ?? [])
    setVariants(variantResult.data ?? [])
  }

  const refreshOrders = useCallback(async () => {
    if (!supabase || !profile) return
    const { data: orderRows, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false })
    if (orderError) throw orderError

    const rows = orderRows ?? []
    const ids = rows.map((order) => order.id)
    let itemRows: OrderItem[] = []
    if (ids.length > 0) {
      const { data, error: itemError } = await supabase
        .from('order_items')
        .select('*')
        .in('order_id', ids)
      if (itemError) throw itemError
      itemRows = data ?? []
    }

    let emailByUser = new Map<string, string>()
    if ((profile.role === 'admin' || profile.role === 'staff') && rows.length > 0) {
      const userIds = [...new Set(rows.map((order) => order.user_id))]
      const { data, error: profileError } = await supabase
        .from('profiles')
        .select('id,email')
        .in('id', userIds)
      if (profileError) throw profileError
      emailByUser = new Map((data ?? []).map((customer) => [customer.id, customer.email]))
    }

    setOrders(
      rows.map((order) => ({
        ...order,
        items: itemRows.filter((item) => item.order_id === order.id),
        customerEmail: emailByUser.get(order.user_id),
      })),
    )
  }, [profile])

  useEffect(() => {
    if (!profile || (page !== 'account' && page !== 'staff')) return
    void Promise.resolve().then(refreshOrders).catch(showError)
  }, [profile, page, refreshOrders])

  useEffect(() => {
    if (!supabase || profile?.role !== 'admin' && profile?.role !== 'staff'
      || page !== 'staff' || staffTab !== 'Customers') return
    void supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false })
      .then(({ data, error: requestError }) => {
        if (requestError) {
          showError(requestError)
          return
        }
        const counts = new Map<string, number>()
        orders.forEach((order) => counts.set(order.user_id, (counts.get(order.user_id) ?? 0) + 1))
        setCustomers((data ?? []).map((customer) => ({ ...customer, orderCount: counts.get(customer.id) ?? 0 })))
      })
  }, [profile?.role, page, staffTab, orders])

  useEffect(() => {
    const client = supabase
    if (!client || !profile || page !== 'staff') return
    let active = true
    if (staffTab === 'Orders' && profile.role !== 'fulfillment') {
      void client
        .from('profiles')
        .select('id,name,email')
        .eq('role', 'fulfillment')
        .order('name')
        .then(({ data, error: requestError }) => {
          if (!active) return
          if (requestError) showError(requestError)
          else setCouriers(data ?? [])
        })
    }
    if (staffTab === 'Reports' && profile.role !== 'fulfillment') {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const loadEvents = async () => {
        const events: StoreEvent[] = []
        for (let offset = 0; active; offset += 1000) {
          const { data, error: requestError } = await client
            .from('store_events')
            .select('*')
            .gte('created_at', since)
            .order('created_at')
            .range(offset, offset + 999)
          if (requestError) throw requestError
          events.push(...(data ?? []))
          if (!data || data.length < 1000) break
        }
        if (active) setStoreEvents(events)
      }
      void loadEvents().catch((reason) => {
        if (active) showError(reason)
      })
    }
    return () => {
      active = false
    }
  }, [profile, page, staffTab])

  const openQuickAdd = (product: Product) => {
    const activeVariants = variants.filter((variant) => variant.product_id === product.id && variant.active)
    setQuickAddProduct(product)
    setQuickAddOption(activeVariants[0]?.name ?? '')
    setQuickAddQuantity(1)
    setError('')
    if (!session) {
      pendingLoginAdd.current = true
      loginDialog.current?.showModal()
      return
    }
    if (activeVariants.length === 0) {
      setQuickAddProduct(null)
      setError(`${product.name} has no available options right now.`)
      return
    }
    const dialog = quickAddDialog.current
    if (dialog && !dialog.open) dialog.showModal()
  }

  const closeQuickAdd = () => {
    quickAddDialog.current?.close()
    setQuickAddProduct(null)
  }

  const addToCart = (product: Product, option: string, quantityToAdd: number) => {
    const quantityInCart = cart
      .filter((line) => line.productId === product.id)
      .reduce((count, line) => count + line.quantity, 0)
    if (quantityToAdd < 1 || quantityInCart + quantityToAdd > product.stock) {
      setError(`Only ${product.stock} ${product.name} available.`)
      return false
    }
    const existing = cart.find((line) => line.productId === product.id && line.option === option)
    saveCart(existing
      ? cart.map((line) =>
          line === existing ? { ...line, quantity: line.quantity + quantityToAdd } : line,
        )
      : [...cart, { productId: product.id, option, quantity: quantityToAdd }])
    setAppliedCoupon('')
    setCouponDiscount(0)
    void trackEvent('add_to_cart', product.id)
      .then(refreshProductPopularity)
      .catch(showError)
    setError('')
    setNotice(`${quantityToAdd} × ${product.name} added to your cart.`)
    return true
  }

  const updateCart = (key: CartLine, quantity: number) => {
    if (quantity <= 0) {
      saveCart(cart.filter(
        (line) => !(line.productId === key.productId && line.option === key.option),
      ))
      setAppliedCoupon('')
      setCouponDiscount(0)
      return
    }
    const product = products.find((item) => item.id === key.productId)
    const otherQuantity = cart
      .filter((line) => line.productId === key.productId && line.option !== key.option)
      .reduce((count, line) => count + line.quantity, 0)
    if (!product || quantity + otherQuantity > product.stock) {
      setError(`The requested quantity exceeds available stock.`)
      return
    }
    saveCart(
      cart.map((line) =>
        line.productId === key.productId && line.option === key.option
          ? { ...line, quantity }
          : line,
      ),
    )
    setAppliedCoupon('')
    setCouponDiscount(0)
    setError('')
  }

  const applyCoupon = async () => {
    const client = supabase
    const code = couponInput.trim().toUpperCase()
    if (!client || !code) {
      setError('Enter a coupon code.')
      return
    }
    await runAction(async () => {
      const { data, error: requestError } = await client.rpc('quote_coupon', {
        p_code: code,
        p_subtotal: subtotal,
      })
      if (requestError) throw requestError
      setAppliedCoupon(code)
      setCouponDiscount(Number(data))
    }, 'Coupon applied.')
  }

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const email = String(form.get('email') ?? '').trim().toLowerCase()
    const password = String(form.get('password') ?? '')
    const client = supabase
    if (!client) return showError(new Error('Supabase is not configured.'))
    await runAction(async () => {
      const { error: requestError } = await client.auth.signInWithPassword({ email, password })
      if (requestError) throw requestError
      if (pendingLoginAdd.current) {
        setPage('shop')
      } else if (cart.length > 0) {
        checkoutStarted.current = true
        void trackEvent('checkout_started').catch(showError)
        setPage('checkout')
      } else {
        navigateTo('shop')
      }
    }, 'Signed in.')
  }

  const signUp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    const email = String(form.get('email') ?? '').trim().toLowerCase()
    const password = String(form.get('password') ?? '')
    const client = supabase
    if (!client) return showError(new Error('Supabase is not configured.'))
    if (!name || password.length < 8) {
      setError('Enter your name and a password with at least 8 characters.')
      return
    }
    let confirmationRequired = false
    await runAction(async () => {
      const { data, error: requestError } = await client.auth.signUp({
        email,
        password,
        options: { data: { name } },
      })
      if (requestError) throw requestError
      if (data.session) {
        if (pendingLoginAdd.current) {
          setPage('shop')
        } else if (cart.length > 0) {
          checkoutStarted.current = true
          void trackEvent('checkout_started').catch(showError)
          setPage('checkout')
        } else {
          navigateTo('shop')
        }
      } else {
        setPage('account')
        setAuthMode('login')
      }
      confirmationRequired = !data.session
    }, 'Account created.')
    if (confirmationRequired) setNotice('Check your email to confirm your new account before signing in.')
  }

  const signOut = async () => {
    const client = supabase
    if (!client) return
    await runAction(async () => {
      const { error: requestError } = await client.auth.signOut()
      if (requestError) throw requestError
      setPage('shop')
      setAuthMode('login')
      setProfile(null)
      setOrders([])
    }, 'Signed out.')
  }

  const notifyOrderEmail = async (
    orderId: string,
    eventType: 'confirmation' | 'cancelled' | 'status_update' | 'return_update',
  ) => {
    const client = supabase
    if (!client) return
    const { error: requestError } = await client.functions.invoke('send-order-email', {
      body: { order_id: orderId, event_type: eventType },
    })
    if (requestError) {
      setError(`Order was saved, but the ${eventType.replace('_', ' ')} email was not sent: ${getErrorMessage(requestError)}`)
    }
  }

  const checkout = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const client = supabase
    if (!client || !session) {
      setAuthMode('login')
      setPage('account')
      return
    }
    const form = new FormData(event.currentTarget)
    const shippingAddress = String(form.get('shipping_address') ?? '').trim()
    const billingAddress = String(form.get('billing_address') ?? '').trim() || shippingAddress
    const items: Json[] = cartEntries.map((item) => ({
      product_id: item.product.id,
      option: item.option,
      quantity: item.quantity,
    }))
    await runAction(async () => {
      const { data, error: requestError } = await client.rpc('place_order', {
        p_customer_name: String(form.get('name') ?? ''),
        p_phone: String(form.get('phone') ?? ''),
        p_billing_address: billingAddress,
        p_shipping_address: shippingAddress,
        p_payment_method: String(form.get('payment_method') ?? '') as Order['payment_method'],
        p_items: items,
        p_coupon_code: appliedCoupon || null,
      })
      if (requestError) throw requestError
      saveCart([])
      setAppliedCoupon('')
      setCouponDiscount(0)
      checkoutStarted.current = false
      setAccountTab('Overview')
      setAccountOrderFilter('All orders')
      setPage('account')
      await refreshProducts()
      await refreshOrders()
      void trackEvent('order_placed').catch(showError)
      await notifyOrderEmail(data, 'confirmation')
    }, 'Order placed. No real payment was processed.')
  }

  const cancelOrder = async (orderId: string) => {
    const client = supabase
    if (!client) return
    await runAction(async () => {
      const { error: requestError } = await client.rpc('cancel_order', { p_order_id: orderId })
      if (requestError) throw requestError
      await refreshOrders()
      await refreshProducts()
      await notifyOrderEmail(orderId, 'cancelled')
    }, 'Order cancelled.')
  }

  const requestReturn = async (orderId: string) => {
    const client = supabase
    if (!client) return
    await runAction(async () => {
      const { error: requestError } = await client.rpc('request_return', { p_order_id: orderId })
      if (requestError) throw requestError
      await refreshOrders()
      await notifyOrderEmail(orderId, 'return_update')
    }, 'Return request sent.')
  }

  const setOrderStatus = async (orderId: string, status: OrderStatus) => {
    const client = supabase
    if (!client) return
    await runAction(async () => {
      const { error: requestError } = await client.rpc('set_order_status', {
        p_order_id: orderId,
        p_status: status,
      })
      if (requestError) throw requestError
      await refreshOrders()
      if (status === 'Cancelled') await refreshProducts()
      await notifyOrderEmail(orderId, status === 'Cancelled' ? 'cancelled' : 'status_update')
    }, 'Order status updated.')
  }

  const reviewReturn = async (orderId: string, decision: 'Approved' | 'Rejected') => {
    const client = supabase
    if (!client) return
    await runAction(async () => {
      const { error: requestError } = await client.rpc('review_return', {
        p_order_id: orderId,
        p_decision: decision,
      })
      if (requestError) throw requestError
      await refreshOrders()
      if (decision === 'Approved') await refreshProducts()
      await notifyOrderEmail(orderId, 'return_update')
    }, `Return ${decision.toLowerCase()}.`)
  }

  const assignCourier = async (orderId: string, courierId: string) => {
    const client = supabase
    if (!client) return false
    let saved = false
    await runAction(async () => {
      const { error: requestError } = await client.rpc('assign_courier', {
        p_order_id: orderId,
        p_courier_id: courierId || null,
      })
      if (requestError) throw requestError
      await refreshOrders()
      saved = true
    }, 'Courier assignment updated.')
    return saved
  }

  const saveTrackingNumber = async (orderId: string, trackingNumber: string) => {
    const client = supabase
    if (!client) return false
    let saved = false
    await runAction(async () => {
      const { error: requestError } = await client.rpc('set_tracking_number', {
        p_order_id: orderId,
        p_tracking_number: trackingNumber || null,
      })
      if (requestError) throw requestError
      await refreshOrders()
      saved = true
    }, 'Tracking details updated.')
    return saved
  }

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const client = supabase
    if (!client) return
    const form = new FormData(event.currentTarget)
    await runAction(async () => {
      const { error: requestError } = await client.rpc('update_my_profile', {
        p_name: String(form.get('name') ?? ''),
      })
      if (requestError) throw requestError
      if (session) await loadProfile(session.user.id)
    }, 'Profile updated.')
  }

  const saveAddress = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const client = supabase
    if (!client || !profile) return
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const isDefault = form.get('is_default') === 'on'
    await runAction(async () => {
      const { data, error: requestError } = await client
        .from('customer_addresses')
        .insert({
          user_id: profile.id,
          label: String(form.get('label') ?? '').trim(),
          full_address: String(form.get('full_address') ?? '').trim(),
          is_default: false,
        })
        .select('id')
        .single()
      if (requestError) throw requestError
      if (isDefault) {
        const { error: defaultError } = await client.rpc('set_default_address', {
          p_address_id: data.id,
        })
        if (defaultError) throw defaultError
      }
      const { data: addressRows, error: addressError } = await client
        .from('customer_addresses')
        .select('*')
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: false })
      if (addressError) throw addressError
      setAddresses(addressRows ?? [])
      formElement.reset()
    }, 'Address saved.')
  }

  const setDefaultAddress = async (addressId: string) => {
    const client = supabase
    if (!client) return
    await runAction(async () => {
      const { error: requestError } = await client.rpc('set_default_address', {
        p_address_id: addressId,
      })
      if (requestError) throw requestError
      setAddresses((current) => current.map((address) => ({ ...address, is_default: address.id === addressId })))
    }, 'Default address updated.')
  }

  const deleteAddress = async (addressId: string) => {
    const client = supabase
    if (!client) return
    await runAction(async () => {
      const { error: requestError } = await client.from('customer_addresses').delete().eq('id', addressId)
      if (requestError) throw requestError
      setAddresses((current) => current.filter((address) => address.id !== addressId))
    }, 'Address removed.')
  }

  const saveProduct = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const client = supabase
    if (!client) return
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const urlValue = String(form.get('image_url') ?? '').trim()
    const imageFile = form.get('image_file')
    const variantLines = String(form.get('variants') ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const variantDrafts = variantLines.map((line) => {
      const separator = line.lastIndexOf('|')
      return {
        name: line.slice(0, separator).trim(),
        price_delta: Number(line.slice(separator + 1).trim()),
      }
    })
    if (
      variantDrafts.length === 0 ||
      variantDrafts.some(
        (variant) =>
          !variant.name ||
          variant.name.length > 80 ||
          !Number.isFinite(variant.price_delta) ||
          variant.price_delta < 0,
      ) ||
      new Set(variantDrafts.map((variant) => variant.name.toLowerCase())).size !== variantDrafts.length
    ) {
      setError('Enter unique variants as “name|price increase”, one per line.')
      return
    }
    if (urlValue) {
      try {
        const parsed = new URL(urlValue)
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error()
      } catch {
        setError('Product images must use an http or https URL.')
        return
      }
    }
    const product: ProductDraft = {
      name: String(form.get('name') ?? '').trim(),
      category: String(form.get('category') ?? 'Beans'),
      description: String(form.get('description') ?? '').trim(),
      price: Number(form.get('price')),
      stock: Number(form.get('stock')),
      image_url: urlValue || null,
    }
    if (imageFile instanceof File && imageFile.size > 0) {
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(imageFile.type)) {
        setError('Upload a JPEG, PNG, WebP, or GIF product image.')
        return
      }
      if (imageFile.size > 5 * 1024 * 1024) {
        setError('Product images must be 5 MB or smaller.')
        return
      }
    }
    await runAction(async () => {
      let productId = editingProduct?.id
      let imageUrl = product.image_url
      if (imageFile instanceof File && imageFile.size > 0) {
        const extension = imageFile.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'img'
        const path = `${crypto.randomUUID()}.${extension}`
        const { error: uploadError } = await client.storage
          .from('product-images')
          .upload(path, imageFile, { contentType: imageFile.type, upsert: false })
        if (uploadError) throw uploadError
        imageUrl = client.storage.from('product-images').getPublicUrl(path).data.publicUrl
      }
      const savedProduct = { ...product, image_url: imageUrl }
      const request = editingProduct
        ? client.from('products').update(savedProduct).eq('id', editingProduct.id).select('id').single()
        : client.from('products').insert(savedProduct).select('id').single()
      const { data: savedRow, error: requestError } = await request
      if (requestError) throw requestError
      productId = savedRow.id
      const { error: variantError } = await client.from('product_variants').upsert(
        variantDrafts.map((variant, index) => ({
          product_id: productId,
          name: variant.name,
          price_delta: variant.price_delta,
          active: true,
          sort_order: index,
        })),
        { onConflict: 'product_id,name' },
      )
      if (variantError) throw variantError
      const oldVariants = variants.filter((variant) => variant.product_id === productId)
      const removedVariants = oldVariants.filter(
        (variant) => !variantDrafts.some((draft) => draft.name === variant.name),
      )
      for (const variant of removedVariants) {
        const { error: archiveError } = await client
          .from('product_variants')
          .update({ active: false })
          .eq('id', variant.id)
        if (archiveError) throw archiveError
      }
      setEditingProduct(null)
      formElement.reset()
      await refreshProducts()
    }, 'Product saved.')
  }

  const toggleProduct = async (product: Product) => {
    const client = supabase
    if (!client) return
    await runAction(async () => {
      const { error: requestError } = await client
        .from('products')
        .update({ active: !product.active })
        .eq('id', product.id)
      if (requestError) throw requestError
      await refreshProducts()
    }, product.active ? 'Product archived.' : 'Product restored.')
  }

  const deleteProduct = async (product: Product) => {
    const client = supabase
    if (!client || product.active) return
    await runAction(async () => {
      const { error: requestError } = await client.from('products').delete().eq('id', product.id)
      if (requestError) throw requestError
      await refreshProducts()
    }, 'Archived product deleted.')
  }

  const saveCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const client = supabase
    if (!client) return
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    await runAction(async () => {
      const { data, error: requestError } = await client
        .from('product_categories')
        .insert({ name: String(form.get('category_name') ?? '').trim() })
        .select('*')
        .single()
      if (requestError) throw requestError
      setCategories((current) => [...current.filter((item) => item.name !== data.name), data].sort((a, b) => a.name.localeCompare(b.name)))
      formElement.reset()
    }, 'Category added.')
  }

  const toggleCategory = async (item: ProductCategory) => {
    const client = supabase
    if (!client) return
    await runAction(async () => {
      const { data, error: requestError } = await client
        .from('product_categories')
        .update({ active: !item.active })
        .eq('name', item.name)
        .select('*')
        .single()
      if (requestError) throw requestError
      setCategories((current) => current.map((categoryItem) => categoryItem.name === item.name ? data : categoryItem))
    }, item.active ? 'Category archived.' : 'Category restored.')
  }

  const updateRole = async (customerId: string, role: Role) => {
    const client = supabase
    if (!client || customerId === profile?.id) return
    await runAction(async () => {
      const { error: requestError } = await client
        .from('profiles')
        .update({ role })
        .eq('id', customerId)
      if (requestError) throw requestError
      const { data, error: profileError } = await client
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false })
      if (profileError) throw profileError
      const counts = new Map<string, number>()
      orders.forEach((order) => counts.set(order.user_id, (counts.get(order.user_id) ?? 0) + 1))
      setCustomers((data ?? []).map((customer) => ({ ...customer, orderCount: counts.get(customer.id) ?? 0 })))
    }, 'Account role updated.')
  }

  const searchQuery = search.trim().toLowerCase()
  const relevanceScore = (product: Product) => {
    if (!searchQuery) return 0
    const name = product.name.toLowerCase()
    const description = product.description.toLowerCase()
    return (name === searchQuery ? 3 : name.includes(searchQuery) ? 2 : 0) +
      (description.includes(searchQuery) ? 1 : 0)
  }
  const visibleProducts = products
    .filter((product) => product.active && (category === 'All' || product.category === category))
    .filter((product) => {
      if (priceRange === 'under-100') return product.price < 100
      if (priceRange === '100-150') return product.price >= 100 && product.price <= 150
      if (priceRange === 'above-150') return product.price > 150
      return true
    })
    .filter((product) =>
      `${product.name} ${product.description}`.toLowerCase().includes(searchQuery),
    )
    .sort((left, right) => {
      if (sort === 'low') return left.price - right.price || left.name.localeCompare(right.name)
      if (sort === 'high') return right.price - left.price || left.name.localeCompare(right.name)
      if (sort === 'popularity') {
        return (productPopularity[right.id] ?? 0) - (productPopularity[left.id] ?? 0) ||
          left.name.localeCompare(right.name)
      }
      return relevanceScore(right) - relevanceScore(left) || left.name.localeCompare(right.name)
    })
  const currentPage = page
  const pendingOrders = orders.filter((order) => order.status === 'Pending')
  const deliveredOrders = orders.filter((order) => order.status === 'Delivered')
  const accountOrders =
    accountOrderFilter === 'In progress'
      ? pendingOrders
      : accountOrderFilter === 'Delivered'
        ? deliveredOrders
        : orders
  const trackingDialogOrder =
    orders.find((order) => order.id === trackingDialogOrderId) ?? null
  const staffTabs: StaffTab[] =
    profile?.role === 'admin'
      ? ['Orders', 'Inventory', 'Customers', 'Reports']
      : profile?.role === 'staff'
        ? ['Orders', 'Customers', 'Reports']
        : ['Orders']

  const renderOrders = (
    staffView: boolean,
    orderList: OrderView[] = orders,
    emptyMessage = 'No orders yet.',
  ) => (
    <div className="order-list">
      {orderList.map((order) => (
        <article className="order-card" key={order.id}>
          <div className="order-heading">
            <strong>{formatOrderNumber(order.id)}{staffView ? ` · ${order.customer_name}` : ''}</strong>
            <span className="status">{order.status}</span>
          </div>
          <p className="muted">
            {new Date(order.created_at).toLocaleString()} · {money(order.total)}
            {staffView && order.customerEmail ? ` · ${order.customerEmail}` : ''}
          </p>
          {order.coupon_code && <p className="muted">Coupon {order.coupon_code} · −{money(order.discount_amount)}</p>}
          {order.status === 'Cancelled' && <p className="muted">Refund: {order.refund_status}</p>}
          {staffView && (
            <p className="muted">
              {order.phone} · Billing: {order.billing_address} · Shipping: {order.shipping_address} · {order.payment_method}
            </p>
          )}
          {order.tracking_number && <p className="muted">Tracking: {order.tracking_number}</p>}
          {staffView && order.courier_id && (
            <p className="muted">
              Courier: {couriers.find((courier) => courier.id === order.courier_id)?.name ?? 'Assigned fulfillment account'}
            </p>
          )}
          <ul className="order-items">
            {order.items.map((item) => (
              <li key={item.id}>
                {item.quantity} × {item.product_name} ({item.product_option})
              </li>
            ))}
          </ul>
          <div className="order-actions">
            {!staffView && ['Pending', 'Packing'].includes(order.status) && (
              <button className="text-button" disabled={busy} onClick={() => void cancelOrder(order.id)}>
                Cancel order
              </button>
            )}
            {!staffView && order.status === 'Delivered' && order.return_status === 'None' && (
              <button className="text-button" disabled={busy} onClick={() => void requestReturn(order.id)}>
                Request return
              </button>
            )}
            {!staffView && order.return_status !== 'None' && (
              <span className="muted">Return: {order.return_status} · Refund: {order.refund_status}</span>
            )}
            <button
              type="button"
              className="button secondary small"
              disabled={trackingDialogLoading}
              onClick={() => void openTrackingDialog(order)}
            >
              Tracking details
            </button>
            {staffView && nextStatuses(order.status).length > 0 &&
              (profile?.role !== 'fulfillment' ||
                (order.courier_id === profile.id && ['Packing', 'Out for delivery'].includes(order.status))) && (
              <label className="inline-control">
                Status
                <select
                  value={order.status}
                  onChange={(event) => void setOrderStatus(order.id, event.target.value as OrderStatus)}
                  disabled={busy}
                >
                  <option value={order.status}>{order.status}</option>
                  {nextStatuses(order.status)
                    .filter((status) =>
                      profile?.role !== 'fulfillment' ||
                      (order.courier_id === profile.id && ['Out for delivery', 'Delivered'].includes(status)),
                    )
                    .map((status) => <option key={status} value={status}>{status}</option>)}
                </select>
              </label>
            )}
            {staffView && order.return_status === 'Requested' && profile?.role === 'admin' && (
              <>
                <button className="button small" disabled={busy} onClick={() => void reviewReturn(order.id, 'Approved')}>
                  Approve return
                </button>
                <button className="button secondary small" disabled={busy} onClick={() => void reviewReturn(order.id, 'Rejected')}>
                  Reject return
                </button>
              </>
            )}
            {staffView && order.return_status !== 'None' && order.return_status !== 'Requested' && (
              <span className="muted">Return: {order.return_status} · Refund: {order.refund_status}</span>
            )}
          </div>
        </article>
      ))}
      {orderList.length === 0 && <p className="empty-state">{emptyMessage}</p>}
    </div>
  )

  return (
    <div className={`app-shell ${currentPage === 'staff' ? 'staff-shell' : 'customer-shell'}`}>
      <header className="site-header">
        <a className="brand" href="#" onClick={(event) => {
          event.preventDefault()
          setShopNavTarget('home')
          navigateTo('shop')
        }}>
          <img className="brand-mark" src="/tasa-mark.svg" alt="" />
          <span>Tasa<small>Kape ng Pilipino, para sa bawat sandali.</small></span>
        </a>
        <nav className="site-nav" aria-label="Main navigation">
          <button
            className={`nav-link ${currentPage === 'shop' && shopNavTarget === 'home' ? 'active' : ''}`}
            aria-current={currentPage === 'shop' && shopNavTarget === 'home' ? 'page' : undefined}
            onClick={() => {
              setShopNavTarget('home')
              navigateTo('shop')
            }}
          >
            Home
          </button>
          <button
            className={`nav-link ${currentPage === 'shop' && shopNavTarget === 'menu' ? 'active' : ''}`}
            aria-current={currentPage === 'shop' && shopNavTarget === 'menu' ? 'page' : undefined}
            onClick={navigateToMenu}
          >
            Menu
          </button>
          <button
            className={`nav-link ${currentPage === 'account' && accountTab === 'Orders' && accountOrderFilter !== 'In progress' ? 'active' : ''}`}
            aria-current={currentPage === 'account' && accountTab === 'Orders' && accountOrderFilter !== 'In progress' ? 'page' : undefined}
            onClick={() => openOrders('All orders')}
          >
            My Orders
          </button>
          <button
            className={`nav-link ${currentPage === 'track' ? 'active' : ''}`}
            aria-current={currentPage === 'track' ? 'page' : undefined}
            onClick={() => navigateTo('track')}
          >
            Track Order
          </button>
        </nav>
        <div className="header-actions">
          <button
            className="header-icon-button"
            type="button"
            aria-label="Order updates"
            title="Order updates"
            onClick={() => navigateTo('track')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
              <path d="M10 21h4" />
            </svg>
          </button>
          <button
            className="header-icon-button cart-icon-button"
            type="button"
            aria-label={`Cart, ${cartCount} ${cartCount === 1 ? 'item' : 'items'}`}
            title="Cart"
            onClick={() => navigateTo('cart')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 4h2l2.2 11.2a2 2 0 0 0 2 1.6h8.5a2 2 0 0 0 1.9-1.4L22 8H6" />
              <circle cx="10" cy="20" r="1" />
              <circle cx="18" cy="20" r="1" />
            </svg>
            {cartCount > 0 && <span className="icon-count" aria-hidden="true">{cartCount}</span>}
          </button>
          {session ? (
            <details className="account-menu">
              <summary className="account-trigger header-icon-button" aria-label="Open account menu" title="Account">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="8" r="3.5" />
                  <path d="M5 20c.6-3.5 3.2-5.5 7-5.5s6.4 2 7 5.5" />
                </svg>
              </summary>
              <div className="account-menu-panel">
                <div className="account-menu-identity">
                  <span className="account-avatar" aria-hidden="true">
                    {profile?.name.trim().charAt(0).toUpperCase() || 'A'}
                  </span>
                  <span>
                    <strong>{profile?.name || 'My account'}</strong>
                    <small>{profile?.email || 'Manage your Tasa account'}</small>
                  </span>
                </div>
                {profile && profile.role !== 'customer' && (
                  <button
                    className="account-menu-item"
                    type="button"
                    onClick={(event) => {
                      navigateTo('staff')
                      event.currentTarget.closest('details')?.removeAttribute('open')
                    }}
                  >
                    Staff
                  </button>
                )}
                <button
                  className="account-menu-item"
                  type="button"
                  onClick={(event) => {
                    setAccountTab('Overview')
                    navigateTo('account')
                    event.currentTarget.closest('details')?.removeAttribute('open')
                  }}
                >
                  My account
                </button>
                <button
                  className="account-menu-item"
                  type="button"
                  onClick={(event) => {
                    openOrders('All orders')
                    event.currentTarget.closest('details')?.removeAttribute('open')
                  }}
                >
                  My orders
                </button>
                <button
                  className="account-menu-item account-menu-signout"
                  type="button"
                  disabled={busy}
                  onClick={(event) => {
                    event.currentTarget.closest('details')?.removeAttribute('open')
                    void signOut()
                  }}
                >
                  Sign out
                </button>
              </div>
            </details>
          ) : (
            <button
              className="header-icon-button"
              type="button"
              aria-label="Account"
              title="Account"
              onClick={() => {
                setAuthMode('login')
                navigateTo('account')
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="8" r="3.5" />
                <path d="M5 20c.6-3.5 3.2-5.5 7-5.5s6.4 2 7 5.5" />
              </svg>
            </button>
          )}
        </div>
      </header>

      <main className="container">
        {notice && <div className="notice" role="status">{notice}</div>}
        {error && <div className="notice error" role="alert">{error}</div>}
        {!supabase && (
          <div className="setup-notice">
            <strong>Supabase is not connected yet.</strong>
            <span>Copy frontend/.env.example to frontend/.env.local and add your project URL and anon key.</span>
          </div>
        )}

        {currentPage === 'shop' && shopNavTarget === 'home' && (
            <section className="hero">
              <div className="hero-copy">
                <span className="eyebrow">MASARAP NA KAPE. MAGANDANG SAMAHAN.</span>
                <h1>Fresh from the roaster</h1>
                <p>Filipino beans, comforting brews, and treats for the moments in between.</p>
                <button className="button hero-menu-button" type="button" onClick={navigateToMenu}>
                  Explore the menu
                </button>
              </div>
              <div className="hero-art" aria-hidden="true"><span>☕</span><b>Made with<br />mahal.</b></div>
            </section>
        )}

        {currentPage === 'shop' && shopNavTarget === 'menu' && (
          <section id="products" className="section menu-page">
            <div className="section-heading">
              <div><span className="eyebrow">THE TASA MENU</span><h1>Find your new favorite</h1></div>
              <p className="muted">Free delivery on orders over ₱1,000</p>
            </div>
            <div className="menu-layout">
              <aside className="menu-filter-panel" aria-label="Menu filters">
                <fieldset className="menu-filter-group">
                  <legend>Sort by</legend>
                  <div className="menu-filter-options">
                    {([
                      ['relevance', 'Relevance'],
                      ['low', 'Price: Low to High'],
                      ['high', 'Price: High to Low'],
                      ['popularity', 'Popularity'],
                    ] as const).map(([value, label]) => (
                      <label className={`menu-filter-radio${sort === value ? ' is-selected' : ''}`} key={value}>
                        <input
                          type="radio"
                          name="product-sort"
                          value={value}
                          checked={sort === value}
                          onChange={() => setSort(value)}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="menu-filter-group">
                  <legend>Price range</legend>
                  <div className="menu-filter-options">
                    {([
                      ['all', 'All Prices'],
                      ['under-100', 'Under ₱100'],
                      ['100-150', '₱100 – ₱150'],
                      ['above-150', 'Above ₱150'],
                    ] as const).map(([value, label]) => (
                      <label className={`menu-filter-radio${priceRange === value ? ' is-selected' : ''}`} key={value}>
                        <input
                          type="radio"
                          name="product-price-range"
                          value={value}
                          checked={priceRange === value}
                          onChange={() => setPriceRange(value)}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </aside>
              <div className="menu-content">
                <div className="menu-search-tools">
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search coffee, pastries, gear"
                    aria-label="Search products"
                  />
                  <select
                    value={category}
                    onChange={(event) => setCategory(event.target.value as 'All' | Category)}
                    aria-label="Filter by category"
                  >
                    <option value="All">All categories</option>
                    {categories.filter((item) => item.active).map((item) => <option key={item.name}>{item.name}</option>)}
                  </select>
                </div>
                {popularityError && (
                  <p className="menu-filter-notice" role="alert">
                    Popularity sorting is unavailable: {popularityError}
                  </p>
                )}
                {loading ? <p className="empty-state">Connecting to Tasa Coffee…</p> : (
                  <div className="product-grid">
                    {visibleProducts.map((product) => (
                      <ProductCard key={product.id} product={product} onAdd={openQuickAdd} busy={busy} />
                    ))}
                    {visibleProducts.length === 0 && (
                      <p className="empty-state">No products match these filters. Try changing your search or filters.</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {currentPage === 'cart' && (
          <section className="section narrow">
            <span className="eyebrow">YOUR ORDER</span><h1>Your cart</h1>
            {cartEntries.length === 0 ? (
              <><p className="muted">Your cart is empty.</p><button className="button" onClick={navigateToMenu}>Browse the menu</button></>
            ) : (
              <>
                {cartEntries.map((item) => (
                  <div className="cart-row" key={`${item.productId}:${item.option}`}>
                    <div><strong>{item.product.name}</strong><p className="muted">{item.option} · {money(item.unitPrice)} each</p></div>
                    <div className="quantity-control">
                      <button aria-label="Decrease quantity" onClick={() => updateCart(item, item.quantity - 1)}>−</button>
                      <span>{item.quantity}</span>
                      <button aria-label="Increase quantity" onClick={() => updateCart(item, item.quantity + 1)}>+</button>
                    </div>
                    <strong>{money(item.unitPrice * item.quantity)}</strong>
                  </div>
                ))}
                <div className="coupon-entry">
                  <label>
                    Coupon code
                    <input
                      value={couponInput}
                      onChange={(event) => {
                        setCouponInput(event.target.value)
                        setAppliedCoupon('')
                        setCouponDiscount(0)
                      }}
                      maxLength={32}
                      placeholder="WELCOME10"
                    />
                  </label>
                  <button className="button secondary" type="button" disabled={busy} onClick={() => void applyCoupon()}>
                    Apply coupon
                  </button>
                </div>
                {appliedCoupon && <p className="muted">Applied: {appliedCoupon} · {money(couponDiscount)} off</p>}
                <Totals
                  subtotal={subtotal}
                  deliveryFee={deliveryFee}
                  discount={couponDiscount}
                  couponCode={appliedCoupon}
                  total={total}
                />
                <button
                  className="button full"
                  onClick={() => {
                    if (session) {
                      setPage('checkout')
                    } else {
                      setAuthMode('login')
                      setPage('account')
                    }
                  }}
                >
                  Continue to checkout
                </button>
              </>
            )}
          </section>
        )}

        {currentPage === 'checkout' && (
          <section className="section checkout-page">
            {!session ? (
              <>
                <p>Please sign in to check out.</p>
                <button
                  className="button"
                  onClick={() => {
                    setAuthMode('login')
                    setPage('account')
                  }}
                >
                  Log in
                </button>
              </>
            ) : !profile ? <p>Loading your account…</p> : cartEntries.length === 0 ? (
              <>
                <span className="eyebrow">YOUR ORDER</span>
                <h1>Checkout</h1>
                <p className="muted">Your cart is empty.</p>
                <button className="button" onClick={navigateToMenu}>Browse the menu</button>
              </>
            ) : (
              <>
                <div className="checkout-heading">
                  <div>
                    <span className="eyebrow">COMPLETE YOUR ORDER</span>
                    <h1>Checkout</h1>
                    <p className="muted">Add your delivery details and choose how you’d like to pay.</p>
                  </div>
                  <button className="button secondary small" type="button" onClick={() => setPage('cart')}>
                    ← Back to cart
                  </button>
                </div>
                <form className="checkout-layout" onSubmit={(event) => void checkout(event)}>
                  <div className="checkout-details">
                    <section className="checkout-card" aria-labelledby="checkout-delivery-title">
                      <div className="checkout-card-heading">
                        <span className="checkout-step-number">01</span>
                        <div>
                          <h2 id="checkout-delivery-title">Contact &amp; delivery</h2>
                          <p className="muted">Where should we send your order?</p>
                        </div>
                      </div>
                      <div className="checkout-email">
                        <span>Order updates will go to</span>
                        <strong>{profile.email}</strong>
                      </div>
                      <div className="checkout-fields">
                        <label className="checkout-field">
                          <span>Full name</span>
                          <input name="name" autoComplete="name" required maxLength={120} defaultValue={profile.name} />
                        </label>
                        <label className="checkout-field">
                          <span>Phone number</span>
                          <input type="tel" name="phone" autoComplete="tel" inputMode="tel" required maxLength={50} />
                        </label>
                        <label className="checkout-field checkout-field-wide">
                          <span>Delivery address</span>
                          {addresses.length > 0 && (
                            <select
                              value={addresses.find((address) => address.full_address === shippingAddress)?.id ?? ''}
                              onChange={(event) => {
                                const address = addresses.find((item) => item.id === event.target.value)
                                if (address) setShippingAddress(address.full_address)
                              }}
                            >
                              <option value="">Enter a new address</option>
                              {addresses.map((address) => (
                                <option key={address.id} value={address.id}>
                                  {address.label}{address.is_default ? ' · Default' : ''}
                                </option>
                              ))}
                            </select>
                          )}
                          <textarea
                            name="shipping_address"
                            autoComplete="shipping street-address"
                            placeholder="House number, street, barangay, city"
                            rows={3}
                            required
                            maxLength={500}
                            value={shippingAddress}
                            onChange={(event) => setShippingAddress(event.target.value)}
                          />
                        </label>
                      </div>
                      <details className="checkout-billing">
                        <summary>Use a different billing address</summary>
                        <label className="checkout-field">
                          <span>Billing address</span>
                          <textarea
                            name="billing_address"
                            autoComplete="billing street-address"
                            placeholder="House number, street, barangay, city"
                            rows={3}
                            maxLength={500}
                          />
                        </label>
                      </details>
                    </section>

                    <section className="checkout-card" aria-labelledby="checkout-payment-title">
                      <div className="checkout-card-heading">
                        <span className="checkout-step-number">02</span>
                        <div>
                          <h2 id="checkout-payment-title">Payment method</h2>
                          <p className="muted">Choose how you’d prefer to pay.</p>
                        </div>
                      </div>
                      <div className="payment-options">
                        <label className="payment-option">
                          <input type="radio" name="payment_method" value="GCash (mock)" defaultChecked required />
                          <span className="payment-option-mark" aria-hidden="true">G</span>
                          <span className="payment-option-copy">
                            <strong>GCash</strong>
                          </span>
                        </label>
                        <label className="payment-option">
                          <input type="radio" name="payment_method" value="Card (mock)" />
                          <span className="payment-option-mark" aria-hidden="true">CC</span>
                          <span className="payment-option-copy">
                            <strong>Credit or debit card</strong>
                          </span>
                        </label>
                        <label className="payment-option">
                          <input type="radio" name="payment_method" value="Cash on delivery" />
                          <span className="payment-option-mark payment-option-mark-text" aria-hidden="true">COD</span>
                          <span className="payment-option-copy">
                            <strong>Cash on delivery</strong>
                          </span>
                        </label>
                      </div>
                    </section>
                  </div>

                  <aside className="checkout-summary" aria-labelledby="checkout-summary-title">
                    <div className="checkout-summary-heading">
                      <h2 id="checkout-summary-title">Order summary</h2>
                      <button className="text-button" type="button" onClick={() => setPage('cart')}>
                        Edit cart
                      </button>
                    </div>
                    <ul className="checkout-items">
                      {cartEntries.map((item) => (
                        <li className="checkout-item" key={`${item.productId}:${item.option}`}>
                          <ProductImage product={item.product} className="checkout-item-image" />
                          <div className="checkout-item-info">
                            <strong>{item.product.name}</strong>
                            <span>{item.option} · Qty {item.quantity}</span>
                          </div>
                          <strong className="checkout-item-price">{money(item.unitPrice * item.quantity)}</strong>
                        </li>
                      ))}
                    </ul>
                    <div className="coupon-entry">
                      <label>
                        Coupon code
                        <input
                          value={couponInput}
                          onChange={(event) => {
                            setCouponInput(event.target.value)
                            setAppliedCoupon('')
                            setCouponDiscount(0)
                          }}
                          maxLength={32}
                          placeholder="WELCOME10"
                        />
                      </label>
                      <button className="button secondary" type="button" disabled={busy} onClick={() => void applyCoupon()}>
                        Apply coupon
                      </button>
                    </div>
                    {appliedCoupon && <p className="muted">Applied: {appliedCoupon} · {money(couponDiscount)} off</p>}
                    <Totals
                      subtotal={subtotal}
                      deliveryFee={deliveryFee}
                      discount={couponDiscount}
                      couponCode={appliedCoupon}
                      total={total}
                    />
                    <button className="button full checkout-place-order" disabled={busy}>
                      <span>{busy ? 'Placing your order…' : 'Place order'}</span>
                      <strong>{money(total)}</strong>
                    </button>
                    <p className="checkout-demo-note">
                      No payment will be collected for this order.
                    </p>
                  </aside>
                </form>
              </>
            )}
          </section>
        )}

        {currentPage === 'track' && (
          <section className="section tracking-page">
            <header className="tracking-hero">
              <span className="eyebrow">ORDER UPDATES</span>
              <h1>Track your order</h1>
              <p>See where your order is, who is delivering it and when it arrives.</p>
            </header>
            <form className="tracking-search" onSubmit={(event) => void findOrder(event)}>
              <label className="sr-only" htmlFor="order-number-search">Order number</label>
              <input
                id="order-number-search"
                name="order_number"
                autoComplete="off"
                value={trackingNumber}
                disabled={trackingBusy}
                onChange={(event) => {
                  setTrackingNumber(event.target.value)
                  setTrackingError('')
                  setTrackedOrder(null)
                }}
                placeholder="Find an order by its number"
                aria-describedby={trackingError ? 'tracking-error' : undefined}
              />
              <button className="button" type="submit" disabled={trackingBusy}>
                {trackingBusy ? 'Finding…' : 'Find'}
              </button>
            </form>
            {trackingError && <p className="tracking-error" id="tracking-error" role="alert">{trackingError}</p>}
            {trackedOrder && <TrackingResult order={trackedOrder} />}
          </section>
        )}

        {currentPage === 'account' && (
          <section className={`section ${profile ? 'account-page' : 'narrow auth-section'}`}>
            {!profile && <span className="eyebrow">WELCOME TO TASA</span>}
            {!profile ? (
              <>
                <h1>{authMode === 'login' ? 'Log in to Tasa' : 'Create your account'}</h1>
                <p className="muted">
                  {authMode === 'login'
                    ? 'Sign in to place an order and manage your account.'
                    : 'Create an account to place orders and track them.'}
                </p>
                {authMode === 'login' ? (
                  <form className="form-card auth-card" onSubmit={(event) => void signIn(event)}>
                    <h2>Log in</h2>
                    <label>Email<input type="email" name="email" autoComplete="email" required /></label>
                    <label>Password<input type="password" name="password" autoComplete="current-password" required /></label>
                    <button className="button full" disabled={busy}>Log in</button>
                    <p className="auth-switch">
                      New to Tasa?{' '}
                      <button type="button" className="text-button" onClick={() => setAuthMode('signup')}>
                        Create an account
                      </button>
                    </p>
                  </form>
                ) : (
                  <form className="form-card auth-card" onSubmit={(event) => void signUp(event)}>
                    <h2>Create account</h2>
                    <label>Name<input name="name" autoComplete="name" maxLength={120} required /></label>
                    <label>Email<input type="email" name="email" autoComplete="email" required /></label>
                    <label>Password (8+ characters)<input type="password" name="password" autoComplete="new-password" minLength={8} maxLength={72} required /></label>
                    <button className="button full" disabled={busy}>Create account</button>
                    <p className="auth-switch">
                      Already have an account?{' '}
                      <button type="button" className="text-button" onClick={() => setAuthMode('login')}>
                        Sign in
                      </button>
                    </p>
                  </form>
                )}
              </>
            ) : (
              <div className="account-layout">
                <aside className="account-sidebar">
                  <div className="account-sidebar-identity">
                    <span className="account-avatar account-avatar-large" aria-hidden="true">
                      {profile.name.trim().charAt(0).toUpperCase() || 'A'}
                    </span>
                    <span className="account-sidebar-name">
                      <strong>{profile.name}</strong>
                      <small>{profile.email}</small>
                    </span>
                  </div>
                  <nav className="account-side-nav" aria-label="Account sections">
                    {(['Overview', 'Orders', 'Profile details'] as const).map((tab) => (
                      <button
                        key={tab}
                        className={accountTab === tab ? 'active' : ''}
                        type="button"
                        aria-current={accountTab === tab ? 'page' : undefined}
                        onClick={() => {
                          if (tab === 'Orders') setAccountOrderFilter('All orders')
                          setAccountTab(tab)
                        }}
                      >
                        {tab}
                      </button>
                    ))}
                  </nav>
                  <button className="account-sidebar-signout" type="button" disabled={busy} onClick={() => void signOut()}>
                    Sign out
                  </button>
                </aside>

                <div className="account-content">
                  <header className="account-content-heading">
                    <span className="eyebrow">MY TASA ACCOUNT</span>
                    <h1>{accountTab}</h1>
                    <p className="muted">
                      {accountTab === 'Overview'
                        ? 'Your orders and account details, all in one place.'
                        : accountTab === 'Orders'
                          ? 'Track recent orders and manage eligible requests.'
                          : 'The contact details connected to your Tasa account.'}
                    </p>
                  </header>

                  {accountTab === 'Overview' && (
                    <>
                      <section className="account-welcome">
                        <div>
                          <span className="eyebrow">WELCOME BACK</span>
                          <h2>{profile.name.split(' ')[0]}</h2>
                          <p>Ready for your next cup? Browse the menu whenever you’re ready.</p>
                        </div>
                        <button className="button" type="button" onClick={navigateToMenu}>Shop the menu</button>
                      </section>
                      <div className="account-stats">
                        <button
                          className="account-stat"
                          type="button"
                          onClick={() => {
                            setAccountOrderFilter('All orders')
                            setAccountTab('Orders')
                          }}
                        >
                          <span>Total orders</span>
                          <strong>{orders.length}</strong>
                          <small>View order history</small>
                        </button>
                        <button
                          className="account-stat"
                          type="button"
                          onClick={() => {
                            setAccountOrderFilter('In progress')
                            setAccountTab('Orders')
                          }}
                        >
                          <span>In progress</span>
                          <strong>{pendingOrders.length}</strong>
                          <small>See order updates</small>
                        </button>
                        <button
                          className="account-stat"
                          type="button"
                          onClick={() => {
                            setAccountOrderFilter('Delivered')
                            setAccountTab('Orders')
                          }}
                        >
                          <span>Delivered</span>
                          <strong>{deliveredOrders.length}</strong>
                          <small>Past deliveries</small>
                        </button>
                      </div>
                      <section className="account-panel">
                        <div className="account-panel-heading">
                          <div>
                            <span className="eyebrow">ORDER ACTIVITY</span>
                            <h2>Recent orders</h2>
                          </div>
                          {orders.length > 0 && (
                            <button
                              className="text-button"
                              type="button"
                              onClick={() => {
                                setAccountOrderFilter('All orders')
                                setAccountTab('Orders')
                              }}
                            >
                              View all
                            </button>
                          )}
                        </div>
                        {renderOrders(false, orders.slice(0, 3))}
                      </section>
                    </>
                  )}

                  {accountTab === 'Orders' && (
                    <section className="account-panel">
                      <div className="account-panel-heading">
                        <div>
                          <span className="eyebrow">YOUR PURCHASES</span>
                          <h2>Order history</h2>
                        </div>
                        <span className="account-order-count">{orders.length} {orders.length === 1 ? 'order' : 'orders'}</span>
                      </div>
                      <div className="tabs account-order-filters" role="group" aria-label="Filter order history">
                        {(['All orders', 'In progress', 'Delivered'] as const).map((filter) => {
                          const count = filter === 'In progress'
                            ? pendingOrders.length
                            : filter === 'Delivered'
                              ? deliveredOrders.length
                              : orders.length
                          return (
                            <button
                              key={filter}
                              className={`tab ${accountOrderFilter === filter ? 'active' : ''}`}
                              type="button"
                              aria-pressed={accountOrderFilter === filter}
                              onClick={() => setAccountOrderFilter(filter)}
                            >
                              {filter} <span>({count})</span>
                            </button>
                          )
                        })}
                      </div>
                      {renderOrders(
                        false,
                        accountOrders,
                        accountOrderFilter === 'In progress'
                          ? 'No pending orders right now.'
                          : accountOrderFilter === 'Delivered'
                            ? 'No delivered orders yet.'
                            : 'No orders yet.',
                      )}
                    </section>
                  )}

                  {accountTab === 'Profile details' && (
                    <section className="account-panel">
                      <div className="account-panel-heading">
                        <div>
                          <span className="eyebrow">ACCOUNT INFORMATION</span>
                          <h2>Profile details</h2>
                        </div>
                      </div>
                      <dl className="account-details-list">
                        <div><dt>Full name</dt><dd>{profile.name}</dd></div>
                        <div><dt>Email address</dt><dd>{profile.email}</dd></div>
                        <div>
                          <dt>Member since</dt>
                          <dd>{new Date(profile.created_at).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })}</dd>
                        </div>
                      </dl>
                      <form className="form-card account-form" onSubmit={(event) => void saveProfile(event)}>
                        <h3>Edit your name</h3>
                        <label>Name<input name="name" required maxLength={120} defaultValue={profile.name} /></label>
                        <button className="button" disabled={busy}>Save profile</button>
                      </form>
                      <div className="account-addresses">
                        <h3>Saved addresses</h3>
                        {addresses.map((address) => (
                          <div className="list-row" key={address.id}>
                            <span><strong>{address.label}</strong> · {address.full_address}{address.is_default ? ' · Default' : ''}</span>
                            <span className="inline-actions">
                              {!address.is_default && <button className="text-button" disabled={busy} onClick={() => void setDefaultAddress(address.id)}>Make default</button>}
                              <button className="text-button" disabled={busy} onClick={() => void deleteAddress(address.id)}>Remove</button>
                            </span>
                          </div>
                        ))}
                        {addresses.length === 0 && <p className="muted">No saved addresses yet.</p>}
                        <form className="form-card" onSubmit={(event) => void saveAddress(event)}>
                          <label>Address label<input name="label" required maxLength={60} placeholder="Home" /></label>
                          <label>Full address<textarea name="full_address" required maxLength={500} rows={3} /></label>
                          <label className="checkbox-label"><input type="checkbox" name="is_default" /> Set as default</label>
                          <button className="button" disabled={busy}>Save address</button>
                        </form>
                      </div>
                    </section>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {currentPage === 'staff' && (
          <section className="section">
            {!profile || profile.role === 'customer' ? (
              <><h1>Staff dashboard</h1><p className="muted">Sign in with a staff account to access this area.</p></>
            ) : (
              <>
                <span className="eyebrow">TASA OPERATIONS</span><h1>Staff dashboard</h1>
                <div className="tabs">
                  {staffTabs.map((tab) => (
                    <button className={`tab ${staffTab === tab ? 'active' : ''}`} key={tab} onClick={() => setStaffTab(tab)}>{tab}</button>
                  ))}
                </div>
                {staffTab === 'Orders' && renderOrders(true)}
                {staffTab === 'Inventory' && profile.role === 'admin' && (
                  <Inventory
                    products={products}
                    categories={categories}
                    variants={variants}
                    editingProduct={editingProduct}
                    setEditingProduct={setEditingProduct}
                    onSave={saveProduct}
                    onToggle={toggleProduct}
                    onDelete={deleteProduct}
                    onSaveCategory={saveCategory}
                    onToggleCategory={toggleCategory}
                    busy={busy}
                  />
                )}
                {staffTab === 'Customers' && (
                  <Customers
                    customers={customers}
                    currentUserId={profile.id}
                    canManage={profile.role === 'admin'}
                    onRole={updateRole}
                    busy={busy}
                  />
                )}
                {staffTab === 'Reports' && <Reports orders={orders} products={products} events={storeEvents} />}
              </>
            )}
          </section>
        )}
      </main>

      <dialog
        ref={loginDialog}
        className="auth-dialog"
        aria-labelledby="add-to-cart-login-title"
        onCancel={() => {
          pendingLoginAdd.current = false
          setQuickAddProduct(null)
        }}
      >
        <div className="quick-add-heading">
          <div>
            <span className="eyebrow">WELCOME TO TASA</span>
            <h2 id="add-to-cart-login-title">Log in to add to your cart</h2>
          </div>
          <button
            type="button"
            className="quick-add-close"
            aria-label="Close sign-in dialog"
            onClick={() => {
              pendingLoginAdd.current = false
              setQuickAddProduct(null)
              loginDialog.current?.close()
            }}
          >
            ×
          </button>
        </div>
        <p className="muted">Sign in to continue adding {quickAddProduct?.name ?? 'this item'} to your cart.</p>
        <form className="form-card auth-card" onSubmit={(event) => void signIn(event)}>
          <label>Email<input type="email" name="email" autoComplete="email" required /></label>
          <label>Password<input type="password" name="password" autoComplete="current-password" required /></label>
          <button className="button full" disabled={busy}>Log in</button>
        </form>
        <div className="auth-dialog-footer">
          <span>New to Tasa?</span>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setAuthMode('signup')
              setPage('account')
              loginDialog.current?.close()
            }}
          >
            Create an account
          </button>
        </div>
      </dialog>

      <dialog
        ref={quickAddDialog}
        className="quick-add-dialog"
        aria-labelledby="quick-add-title"
        aria-describedby="quick-add-description"
        onClose={() => setQuickAddProduct(null)}
      >
        {quickAddProduct && (
          <>
            <div className="quick-add-heading">
              <div>
                <span className="product-category">{quickAddProduct.category}</span>
                <h2 id="quick-add-title">{quickAddProduct.name}</h2>
              </div>
              <button
                type="button"
                className="quick-add-close"
                aria-label="Close"
                onClick={closeQuickAdd}
              >
                ×
              </button>
            </div>
            <p id="quick-add-description" className="muted">{quickAddProduct.description}</p>
            <div className="quick-add-controls">
              {quickAddVariants.length > 0 ? (
                <label className="option-label" htmlFor="quick-add-option">
                  Choose an option
                  <select
                    id="quick-add-option"
                    value={quickAddOption}
                    autoFocus
                    onChange={(event) => setQuickAddOption(event.target.value)}
                    disabled={quickAddVariants.length === 1}
                  >
                    {quickAddVariants.map((variant) => (
                      <option key={variant.id} value={variant.name}>{variant.name}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="notice error" role="alert">Purchase options are unavailable right now. Please try again later.</p>
              )}
              <div className="quick-add-quantity">
                <span>Quantity</span>
                <div className="quantity-control">
                  <button
                    type="button"
                    aria-label="Decrease quantity"
                    disabled={quickAddQuantity <= 1}
                    onClick={() => setQuickAddQuantity((quantity) => quantity - 1)}
                  >
                    −
                  </button>
                  <span aria-live="polite">{quickAddQuantity}</span>
                  <button
                    type="button"
                    aria-label="Increase quantity"
                    disabled={quickAddQuantity >= quickAddRemaining}
                    onClick={() => setQuickAddQuantity((quantity) => quantity + 1)}
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="quick-add-summary">
                <span className="muted">
                  {quickAddRemaining > 0
                    ? `${quickAddRemaining} available`
                    : 'No additional stock available'}
                </span>
                <strong>
                  Total: {money(quickAddUnitPrice * quickAddQuantity)}
                </strong>
              </div>
            </div>
            <div className="quick-add-actions">
              <button type="button" className="button secondary" onClick={closeQuickAdd}>
                Cancel
              </button>
              <button
                type="button"
                className="button"
                disabled={!quickAddVariant || quickAddQuantity > quickAddRemaining}
                onClick={() => {
                  if (quickAddProduct && addToCart(quickAddProduct, quickAddOption, quickAddQuantity)) {
                    closeQuickAdd()
                  }
                }}
              >
                Add to cart
              </button>
            </div>
          </>
        )}
      </dialog>

      <dialog
        ref={trackingDialog}
        className="tracking-dialog"
        aria-labelledby="tracking-dialog-title"
        onClose={() => {
          trackingDialogRequest.current += 1
          setTrackingDialogOrderId(null)
          setTrackingDialogDetails(null)
          setTrackingDialogError('')
          setTrackingDialogLoading(false)
        }}
      >
        <div className="quick-add-heading">
          <div>
            <span className="eyebrow">ORDER TRACKING</span>
            <h2 id="tracking-dialog-title">Tracking details</h2>
          </div>
          <button
            type="button"
            className="quick-add-close"
            aria-label="Close tracking details"
            onClick={() => trackingDialog.current?.close()}
          >
            ×
          </button>
        </div>
        {trackingDialogLoading && <p className="muted" role="status">Loading tracking details…</p>}
        {trackingDialogError && <p className="tracking-dialog-error" role="alert">{trackingDialogError}</p>}
        {error && <p className="tracking-dialog-error" role="alert">{error}</p>}
        {notice && <p className="tracking-dialog-success" role="status">{notice}</p>}
        {trackingDialogDetails && <TrackingResult order={trackingDialogDetails} />}
        {trackingDialogOrder && (
          <section className="tracking-edit-panel">
            <div>
              <span className="eyebrow">STAFF CONTROLS</span>
              <h3>Update delivery details</h3>
            </div>
            {(profile?.role === 'admin' || profile?.role === 'staff') && (
              <label>
                Courier
                <select
                  value={trackingDialogOrder.courier_id ?? ''}
                  disabled={busy}
                  onChange={async (event) => {
                    const courierId = event.currentTarget.value
                    const saved = await assignCourier(trackingDialogOrder.id, courierId)
                    if (saved) {
                      const courierName = couriers.find((courier) => courier.id === courierId)?.name ?? null
                      setTrackingDialogDetails((details) =>
                        details ? { ...details, courier_name: courierName } : details,
                      )
                    }
                  }}
                >
                  <option value="">Unassigned</option>
                  {couriers.map((courier) => (
                    <option key={courier.id} value={courier.id}>{courier.name} · {courier.email}</option>
                  ))}
                </select>
              </label>
            )}
            {(profile?.role === 'admin' || profile?.role === 'staff' ||
              (profile?.role === 'fulfillment' && trackingDialogOrder.courier_id === profile.id)) && (
              <form
                key={`${trackingDialogOrder.id}:${trackingDialogOrder.tracking_number ?? ''}`}
                className="tracking-edit-form"
                onSubmit={async (event) => {
                  event.preventDefault()
                  const form = new FormData(event.currentTarget)
                  const trackingNumber = String(form.get('tracking_number') ?? '').trim()
                  const saved = await saveTrackingNumber(trackingDialogOrder.id, trackingNumber)
                  if (saved) {
                    setTrackingDialogDetails((details) =>
                      details ? { ...details, tracking_number: trackingNumber || null } : details,
                    )
                  }
                }}
              >
                <label>
                  Tracking number
                  <input name="tracking_number" maxLength={80} defaultValue={trackingDialogOrder.tracking_number ?? ''} />
                </label>
                <button className="button small" disabled={busy}>Save tracking</button>
              </form>
            )}
          </section>
        )}
      </dialog>

      <footer className="site-footer">
        <a className="brand" href="#" onClick={(event) => {
          event.preventDefault()
          setShopNavTarget('home')
          navigateTo('shop')
        }}>
          <img className="brand-mark" src="/tasa-mark.svg" alt="" /><span>Tasa</span>
        </a>
        <span>Kape ng Pilipino, para sa bawat sandali.</span>
      </footer>
    </div>
  )
}

function ProductCard({
  product,
  onAdd,
  busy,
}: {
  product: Product
  onAdd: (product: Product) => void
  busy: boolean
}) {
  return (
    <article className="product-card">
      <ProductImage product={product} className="product-image" />
      <span className="product-category">{product.category}</span>
      <h3>{product.name}</h3>
      <p className="muted">{product.description}</p>
      <div className="product-buy">
        <strong>{money(Number(product.price))}</strong>
        {product.stock > 0
          ? <button className="button" disabled={busy} onClick={() => onAdd(product)}>Add to cart</button>
          : <span className="muted">Sold out</span>}
      </div>
    </article>
  )
}

function TrackingResult({ order }: { order: TrackedOrder }) {
  const stages = [
    { status: 'Pending', title: 'Order placed', detail: 'We have received your order.' },
    { status: 'Packing', title: 'Preparing', detail: 'The café is preparing your items.' },
    { status: 'Out for delivery', title: 'On the way', detail: 'Your order is on its way to you.' },
    { status: 'Delivered', title: 'Delivered', detail: 'Your order has arrived.' },
  ] as const
  const stageIndex = stages.findIndex((stage) => stage.status === order.status)
  const isException = order.status === 'Cancelled' || order.status === 'Returned'
  const paymentStatus = order.payment_method === 'Cash on delivery'
    ? order.status === 'Delivered' ? 'Paid on delivery' : 'Due on delivery'
    : 'Demo payment'
  const placedDate = new Date(order.created_at).toLocaleDateString('en-PH', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <div className="tracking-result">
      <article className="tracking-card tracking-progress-card">
        <div className="tracking-order-heading">
          <div>
            <span className="eyebrow">ORDER STATUS</span>
            <h2>{formatOrderNumber(order.id)}</h2>
            <p className="muted">Placed {placedDate}</p>
          </div>
          <span className={`tracking-status ${isException ? 'is-exception' : ''}`}>{order.status}</span>
        </div>
        {isException ? (
          <p className="tracking-exception">
            This order is {order.status.toLowerCase()}. Please contact Tasa if you need help with it.
          </p>
        ) : (
          <ol className="tracking-timeline">
            {stages.map((stage, index) => {
              const complete = index <= stageIndex
              return (
                <li
                  className={`tracking-stage${complete ? ' is-complete' : ''}${index === stageIndex ? ' is-current' : ''}`}
                  key={stage.status}
                >
                  <span className="tracking-stage-marker" aria-hidden="true">{complete ? '✓' : index + 1}</span>
                  <div>
                    <strong>{stage.title}</strong>
                    <p className="muted">{stage.detail}</p>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
        <div className="tracking-details-grid">
          <div>
            <span className="tracking-detail-label">Courier</span>
            <strong>{order.courier_name || 'Not assigned yet'}</strong>
          </div>
          <div>
            <span className="tracking-detail-label">Tracking number</span>
            <strong>{order.tracking_number || 'Available once dispatched'}</strong>
          </div>
          <div className="tracking-address">
            <span className="tracking-detail-label">Delivery address</span>
            <strong>{order.shipping_address}</strong>
          </div>
        </div>
      </article>

      <aside className="tracking-card tracking-summary-card">
        <span className="eyebrow">ORDER SUMMARY</span>
        <h2>What’s in this order</h2>
        <ul className="tracking-items">
          {order.items.map((item, index) => (
            <li key={`${item.product_name}-${item.product_option}-${index}`}>
              <span className="tracking-item-quantity">{item.quantity}×</span>
              <span className="tracking-item-name">
                <strong>{item.product_name}</strong>
                {item.product_option && <small>{item.product_option}</small>}
              </span>
              <strong>{money(item.unit_price * item.quantity)}</strong>
            </li>
          ))}
        </ul>
        <dl className="tracking-totals">
          <div><dt>Subtotal</dt><dd>{money(order.subtotal)}</dd></div>
          <div><dt>Delivery fee</dt><dd>{money(order.delivery_fee)}</dd></div>
          <div className="tracking-total"><dt>Total</dt><dd>{money(order.total)}</dd></div>
        </dl>
        <div className="tracking-payment">
          <span>Payment · {order.payment_method}</span>
          <strong>{paymentStatus}</strong>
        </div>
      </aside>
    </div>
  )
}

function ProductImage({ product, className }: { product: Product; className: string }) {
  const fallbackPhoto = productPhotos[product.name] ?? categoryPhotos[product.category]
  return (
    <img
      className={className}
      src={product.image_url || fallbackPhoto}
      alt=""
      loading="lazy"
      decoding="async"
      onError={(event) => {
        if (event.currentTarget.getAttribute('src') !== fallbackPhoto) {
          event.currentTarget.src = fallbackPhoto
        }
      }}
    />
  )
}

function Totals({
  subtotal,
  deliveryFee,
  discount,
  couponCode,
  total,
}: {
  subtotal: number
  deliveryFee: number
  discount: number
  couponCode: string
  total: number
}) {
  return (
    <div className="totals">
      <div><span>Subtotal</span><strong>{money(subtotal)}</strong></div>
      {couponCode && <div><span>Coupon ({couponCode})</span><strong>−{money(discount)}</strong></div>}
      <div><span>Delivery {deliveryFee === 0 ? '(free over ₱1,000)' : ''}</span><strong>{money(deliveryFee)}</strong></div>
      <div className="total"><span>Total</span><strong>{money(total)}</strong></div>
    </div>
  )
}

function Inventory({
  products,
  categories,
  variants,
  editingProduct,
  setEditingProduct,
  onSave,
  onToggle,
  onDelete,
  onSaveCategory,
  onToggleCategory,
  busy,
}: {
  products: Product[]
  categories: ProductCategory[]
  variants: ProductVariant[]
  editingProduct: Product | null
  setEditingProduct: (product: Product | null) => void
  onSave: (event: FormEvent<HTMLFormElement>) => void
  onToggle: (product: Product) => void
  onDelete: (product: Product) => void
  onSaveCategory: (event: FormEvent<HTMLFormElement>) => void
  onToggleCategory: (category: ProductCategory) => void
  busy: boolean
}) {
  return (
    <>
      <form className="form-card inventory-form" key={editingProduct?.id ?? 'new'} onSubmit={onSave}>
        <h2>{editingProduct ? 'Edit product' : 'Add product'}</h2>
        <label>Name<input name="name" required maxLength={160} defaultValue={editingProduct?.name ?? ''} /></label>
        <label>
          Category
          <select name="category" defaultValue={editingProduct?.category ?? categories.find((item) => item.active)?.name ?? 'Beans'}>
            {categories.filter((item) => item.active || item.name === editingProduct?.category).map((item) => <option key={item.name}>{item.name}</option>)}
          </select>
        </label>
        <label>Description<input name="description" maxLength={1000} defaultValue={editingProduct?.description ?? ''} /></label>
        <label>Price (₱)<input type="number" name="price" min="0" step="0.01" required defaultValue={editingProduct?.price ?? ''} /></label>
        <label>Stock<input type="number" name="stock" min="0" step="1" required defaultValue={editingProduct?.stock ?? ''} /></label>
        <label>Image URL<input type="url" name="image_url" placeholder="https://…" defaultValue={editingProduct?.image_url ?? ''} /></label>
        <label>Or upload an image<input type="file" name="image_file" accept="image/jpeg,image/png,image/webp,image/gif" /></label>
        <label>
          Variants (one per line: name|price increase)
          <textarea
            name="variants"
            required
            rows={4}
            defaultValue={editingProduct
              ? variants
                  .filter((variant) => variant.product_id === editingProduct.id && variant.active)
                  .map((variant) => `${variant.name}|${variant.price_delta}`)
                  .join('\n') || defaultVariantLines(editingProduct.category)
              : defaultVariantLines(categories.find((item) => item.active)?.name ?? 'Beans')}
          />
        </label>
        <div className="inline-actions">
          <button className="button" disabled={busy}>{editingProduct ? 'Save changes' : 'Add product'}</button>
          {editingProduct && <button type="button" className="button secondary" onClick={() => setEditingProduct(null)}>Cancel edit</button>}
        </div>
      </form>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Visibility</th><th>Actions</th></tr></thead>
          <tbody>{products.map((product) => (
            <tr key={product.id}>
              <td>{product.name}</td><td>{product.category}</td><td>{money(Number(product.price))}</td><td>{product.stock}</td><td>{product.active ? 'Active' : 'Archived'}</td>
              <td className="table-actions">
                <button className="text-button" onClick={() => setEditingProduct(product)}>Edit</button>
                <button className="text-button" disabled={busy} onClick={() => void onToggle(product)}>{product.active ? 'Archive' : 'Restore'}</button>
                {!product.active && <button className="text-button danger" disabled={busy} onClick={() => {
                  if (window.confirm(`Permanently delete ${product.name}?`)) onDelete(product)
                }}>Delete</button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <section className="category-manager">
        <h2>Product categories</h2>
        <form className="inline-actions" onSubmit={onSaveCategory}>
          <label>New category<input name="category_name" required maxLength={60} /></label>
          <button className="button" disabled={busy}>Add category</button>
        </form>
        {categories.map((category) => (
          <div className="list-row" key={category.name}>
            <span>{category.name} · {category.active ? 'Active' : 'Archived'}</span>
            <button className="text-button" disabled={busy} onClick={() => onToggleCategory(category)}>
              {category.active ? 'Archive' : 'Restore'}
            </button>
          </div>
        ))}
      </section>
    </>
  )
}

function Customers({
  customers,
  currentUserId,
  canManage,
  onRole,
  busy,
}: {
  customers: CustomerView[]
  currentUserId: string
  canManage: boolean
  onRole: (customerId: string, role: Role) => void
  busy: boolean
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Orders</th><th>Role</th></tr></thead>
        <tbody>{customers.map((customer) => (
          <tr key={customer.id}>
            <td>{customer.name}</td><td>{customer.email}</td><td>{customer.orderCount}</td>
            <td>{canManage && customer.id !== currentUserId
              ? <select
                  aria-label={`Role for ${customer.email}`}
                  value={customer.role === 'customer' || customer.role === 'admin' ? customer.role : ''}
                  disabled={busy}
                  onChange={(event) => onRole(customer.id, event.target.value as Role)}
                >
                  {customer.role !== 'customer' && customer.role !== 'admin' && (
                    <option value="" disabled hidden />
                  )}
                  {(['customer', 'admin'] as const).map((role) => <option key={role} value={role}>{role}</option>)}
                </select>
              : customer.role === 'customer' || customer.role === 'admin'
                ? customer.role
                : null}</td>
          </tr>
        ))}</tbody>
      </table>
      {customers.length === 0 && <p className="empty-state">No customer accounts yet.</p>}
    </div>
  )
}

function Reports({
  orders,
  products,
  events,
}: {
  orders: OrderView[]
  products: Product[]
  events: StoreEvent[]
}) {
  const completed = orders.filter((order) => order.status === 'Delivered')
  const revenue = completed.reduce((sum, order) => sum + Number(order.total), 0)
  const sold = new Map<string, number>()
  completed.forEach((order) =>
    order.items.forEach((item) => sold.set(item.product_name, (sold.get(item.product_name) ?? 0) + item.quantity)),
  )
  const topProducts = [...sold.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5)
  const lowStock = products.filter((product) => product.active && product.stock < 10)
  const checkoutVisitors = new Set(
    events.filter((event) => event.event_type === 'checkout_started').map((event) => event.visitor_id),
  )
  const convertedVisitors = new Set(
    events
      .filter((event) => event.event_type === 'order_placed' && checkoutVisitors.has(event.visitor_id))
      .map((event) => event.visitor_id),
  )
  const abandonedVisitors = new Set(
    events.filter((event) => event.event_type === 'order_abandoned').map((event) => event.visitor_id),
  ).size
  const conversionRate = checkoutVisitors.size === 0 ? 0 : (convertedVisitors.size / checkoutVisitors.size) * 100

  return (
    <>
      <div className="stats">
        <article className="stat-card"><span className="muted">Delivered revenue · all time</span><strong>{money(revenue)}</strong></article>
        <article className="stat-card"><span className="muted">Orders · all time</span><strong>{orders.length}</strong></article>
        <article className="stat-card"><span className="muted">30-day conversion</span><strong>{conversionRate.toFixed(1)}%</strong></article>
        <article className="stat-card"><span className="muted">Abandoned checkouts</span><strong>{abandonedVisitors}</strong></article>
      </div>
      <p className="muted">Sales include delivered orders only. Payments and refunds are simulated.</p>
      <h2>Top products</h2>
      {topProducts.map(([name, count]) => <div className="list-row" key={name}><span>{name}</span><strong>{count} sold</strong></div>)}
      {topProducts.length === 0 && <p className="muted">No sales yet.</p>}
      <h2>Low stock</h2>
      {lowStock.map((product) => <div className="list-row" key={product.id}><span>{product.name}</span><strong>{product.stock} left</strong></div>)}
      {lowStock.length === 0 && <p className="muted">No low-stock products.</p>}
    </>
  )
}

export default App
