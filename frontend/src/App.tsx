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
  Json,
  Order,
  OrderItem,
  OrderStatus,
  Product,
  Profile,
  Role,
} from './lib/database.types'
import './App.css'

type Page = 'shop' | 'cart' | 'checkout' | 'account' | 'staff'
type StaffTab = 'Orders' | 'Inventory' | 'Customers' | 'Reports'
type AccountTab = 'Overview' | 'Orders' | 'Profile details'
type AccountOrderFilter = 'All orders' | 'In progress' | 'Delivered'
type CartLine = { productId: string; option: string; quantity: number }
type CartEntry = CartLine & { product: Product; unitPrice: number }
type ProductDraft = Pick<Product, 'name' | 'category' | 'description' | 'price' | 'stock' | 'image_url'>
type OrderView = Order & { items: OrderItem[]; customerEmail?: string }
type CustomerView = Profile & { orderCount: number }

const categories: Category[] = ['Beans', 'Brewed', 'Pastries', 'Merch']
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
const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'The request could not be completed.'

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

function optionsFor(category: Category): string[] {
  if (category === 'Beans') return ['Whole bean', 'Espresso grind', 'Filter grind']
  if (category === 'Brewed') return ['Regular', 'Large (+₱30)']
  return ['Standard']
}

function optionPrice(product: Product, option: string): number {
  return Number(product.price) + (option === 'Large (+₱30)' ? 30 : 0)
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

function App() {
  const [storedCart] = useState(readInitialCart)
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [page, setPage] = useState<Page>('account')
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login')
  const [staffTab, setStaffTab] = useState<StaffTab>('Orders')
  const [accountTab, setAccountTab] = useState<AccountTab>('Overview')
  const [accountOrderFilter, setAccountOrderFilter] = useState<AccountOrderFilter>('All orders')
  const [products, setProducts] = useState<Product[]>([])
  const [orders, setOrders] = useState<OrderView[]>([])
  const [customers, setCustomers] = useState<CustomerView[]>([])
  const [cart, setCart] = useState<CartLine[]>(storedCart.cart)
  const [quickAddProduct, setQuickAddProduct] = useState<Product | null>(null)
  const [quickAddOption, setQuickAddOption] = useState('')
  const [quickAddQuantity, setQuickAddQuantity] = useState(1)
  const quickAddDialog = useRef<HTMLDialogElement>(null)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<'All' | Category>('All')
  const [sort, setSort] = useState<'name' | 'low' | 'high'>('name')
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState(
    supabase ? storedCart.error : 'Add the Supabase URL and anon key in frontend/.env.local to connect this app.',
  )
  const [loading, setLoading] = useState(Boolean(supabase))
  const [busy, setBusy] = useState(false)

  const showError = (reason: unknown) => {
    setError(getErrorMessage(reason))
    setNotice('')
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
    try {
      window.localStorage.setItem('tasa-cart', JSON.stringify(cart))
    } catch (reason) {
      const message = `Could not save your cart: ${getErrorMessage(reason)}`
      queueMicrotask(() => setError(message))
    }
  }, [cart])

  const cartEntries = useMemo<CartEntry[]>(
    () =>
      cart.flatMap((line) => {
        const product = products.find((candidate) => candidate.id === line.productId)
        return product
          ? [{ ...line, product, unitPrice: optionPrice(product, line.option) }]
          : []
      }),
    [cart, products],
  )
  const cartCount = cart.reduce((total, item) => total + item.quantity, 0)
  const subtotal = cartEntries.reduce((total, item) => total + item.unitPrice * item.quantity, 0)
  const deliveryFee = subtotal === 0 || subtotal >= 1000 ? 0 : 60
  const total = subtotal + deliveryFee
  const quickAddRemaining = quickAddProduct
    ? Math.max(
        0,
        quickAddProduct.stock -
          cart
            .filter((line) => line.productId === quickAddProduct.id)
            .reduce((count, line) => count + line.quantity, 0),
      )
    : 0

  const refreshProducts = async () => {
    if (!supabase) return
    const { data, error: requestError } = await supabase.from('products').select('*').order('name')
    if (requestError) throw requestError
    setProducts(data ?? [])
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
    if (profile.role !== 'customer' && rows.length > 0) {
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

  const openQuickAdd = (product: Product) => {
    const dialog = quickAddDialog.current
    if (dialog && !dialog.open) dialog.showModal()
    setQuickAddProduct(product)
    setQuickAddOption(optionsFor(product.category)[0])
    setQuickAddQuantity(1)
    setError('')
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
    setCart((current) => {
      const existing = current.find(
        (line) => line.productId === product.id && line.option === option,
      )
      return existing
        ? current.map((line) =>
            line === existing ? { ...line, quantity: line.quantity + quantityToAdd } : line,
          )
        : [...current, { productId: product.id, option, quantity: quantityToAdd }]
    })
    setError('')
    setNotice(`${quantityToAdd} × ${product.name} added to your cart.`)
    return true
  }

  const updateCart = (key: CartLine, quantity: number) => {
    if (quantity <= 0) {
      setCart((current) =>
        current.filter(
          (line) => !(line.productId === key.productId && line.option === key.option),
        ),
      )
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
    setCart((current) =>
      current.map((line) =>
        line.productId === key.productId && line.option === key.option
          ? { ...line, quantity }
          : line,
      ),
    )
    setError('')
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
      setPage('shop')
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
        setPage('shop')
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
      setPage('account')
      setAuthMode('login')
      setProfile(null)
      setOrders([])
    }, 'Signed out.')
  }

  const checkout = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const client = supabase
    if (!client || !session) {
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
      })
      if (requestError) throw requestError
      setCart([])
      setAccountTab('Overview')
      setAccountOrderFilter('All orders')
      setPage('account')
      await refreshProducts()
      await refreshOrders()
      setNotice(`Order ${data.slice(0, 8).toUpperCase()} placed. No real payment was processed.`)
    }, 'Order placed.')
  }

  const cancelOrder = async (orderId: string) => {
    const client = supabase
    if (!client) return
    await runAction(async () => {
      const { error: requestError } = await client.rpc('cancel_order', { p_order_id: orderId })
      if (requestError) throw requestError
      await refreshOrders()
      await refreshProducts()
    }, 'Order cancelled.')
  }

  const requestReturn = async (orderId: string) => {
    const client = supabase
    if (!client) return
    await runAction(async () => {
      const { error: requestError } = await client.rpc('request_return', { p_order_id: orderId })
      if (requestError) throw requestError
      await refreshOrders()
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
    }, `Return ${decision.toLowerCase()}.`)
  }

  const saveProduct = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const client = supabase
    if (!client) return
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const urlValue = String(form.get('image_url') ?? '').trim()
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
      category: String(form.get('category') ?? 'Beans') as Category,
      description: String(form.get('description') ?? '').trim(),
      price: Number(form.get('price')),
      stock: Number(form.get('stock')),
      image_url: urlValue || null,
    }
    await runAction(async () => {
      const request = editingProduct
        ? client.from('products').update(product).eq('id', editingProduct.id)
        : client.from('products').insert(product)
      const { error: requestError } = await request
      if (requestError) throw requestError
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

  const visibleProducts = products
    .filter((product) => product.active && (category === 'All' || product.category === category))
    .filter((product) =>
      `${product.name} ${product.description}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((left, right) =>
      sort === 'low'
        ? left.price - right.price
        : sort === 'high'
          ? right.price - left.price
          : left.name.localeCompare(right.name),
    )
  const currentPage = session ? page : 'account'
  const pendingOrders = orders.filter((order) => order.status === 'Pending')
  const deliveredOrders = orders.filter((order) => order.status === 'Delivered')
  const accountOrders =
    accountOrderFilter === 'In progress'
      ? pendingOrders
      : accountOrderFilter === 'Delivered'
        ? deliveredOrders
        : orders
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
            <strong>#{order.id.slice(0, 8).toUpperCase()}{staffView ? ` · ${order.customer_name}` : ''}</strong>
            <span className="status">{order.status}</span>
          </div>
          <p className="muted">
            {new Date(order.created_at).toLocaleString()} · {money(order.total)}
            {staffView && order.customerEmail ? ` · ${order.customerEmail}` : ''}
          </p>
          {staffView && (
            <p className="muted">
              {order.phone} · {order.shipping_address} · {order.payment_method}
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
              <span className="muted">Return: {order.return_status}</span>
            )}
            {staffView && nextStatuses(order.status).length > 0 && (
              <label className="inline-control">
                Status
                <select
                  value={order.status}
                  onChange={(event) => void setOrderStatus(order.id, event.target.value as OrderStatus)}
                  disabled={busy}
                >
                  <option value={order.status}>{order.status}</option>
                  {nextStatuses(order.status)
                    .filter((status) => profile?.role !== 'fulfillment' || status !== 'Cancelled')
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
              <span className="muted">Return: {order.return_status}</span>
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
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setPage(session ? 'shop' : 'account') }}>
          <span className="brand-mark" aria-hidden="true">☕</span>
          <span>Tasa<small>Kape ng Pilipino, para sa bawat sandali.</small></span>
        </a>
        <nav aria-label="Main navigation">
          {session ? (
            <>
              <button className="nav-link" onClick={() => setPage('cart')}>Cart <span className="cart-count">{cartCount}</span></button>
              {profile && profile.role !== 'customer' && (
                <button className="nav-link" onClick={() => setPage('staff')}>Staff</button>
              )}
              <details className="account-menu">
                <summary className="account-trigger" aria-label="Open account menu">
                  <span className="account-avatar account-avatar-small" aria-hidden="true">
                    {profile?.name.trim().charAt(0).toUpperCase() || 'A'}
                  </span>
                  <span className="account-trigger-copy">
                    <strong>Account</strong>
                    <small>{profile?.name.split(' ')[0] || 'Profile & orders'}</small>
                  </span>
                  <span className="account-chevron" aria-hidden="true">⌄</span>
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
                  <button
                    className="account-menu-item"
                    type="button"
                    onClick={(event) => {
                      setAccountTab('Overview')
                      setPage('account')
                      event.currentTarget.closest('details')?.removeAttribute('open')
                    }}
                  >
                    My account
                  </button>
                  <button
                    className="account-menu-item"
                    type="button"
                    onClick={(event) => {
                      setAccountTab('Orders')
                      setAccountOrderFilter('All orders')
                      setPage('account')
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
            </>
          ) : (
            <button className="nav-link" onClick={() => setPage('account')}>Log in</button>
          )}
        </nav>
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

        {currentPage === 'shop' && (
          <>
            <section className="hero">
              <div className="hero-copy">
                <span className="eyebrow">MASARAP NA KAPE. MAGANDANG SAMAHAN.</span>
                <h1>Fresh from the roaster</h1>
                <p>Filipino beans, comforting brews, and treats for the moments in between.</p>
              </div>
              <div className="hero-art" aria-hidden="true"><span>☕</span><b>Made with<br />mahal.</b></div>
            </section>
            <section id="products" className="section">
              <div className="section-heading">
                <div><span className="eyebrow">THE TASA MENU</span><h2>Find your new favorite</h2></div>
                <p className="muted">Free delivery on orders over ₱1,000</p>
              </div>
              <div className="filters">
                <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search coffee, pastries, gear" aria-label="Search products" />
                <select value={category} onChange={(event) => setCategory(event.target.value as 'All' | Category)} aria-label="Filter by category">
                  <option value="All">All categories</option>
                  {categories.map((item) => <option key={item}>{item}</option>)}
                </select>
                <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label="Sort products">
                  <option value="name">Name</option><option value="low">Price: low to high</option><option value="high">Price: high to low</option>
                </select>
              </div>
              {loading ? <p className="empty-state">Connecting to Tasa Coffee…</p> : (
                <div className="product-grid">
                  {visibleProducts.map((product) => (
                    <ProductCard key={product.id} product={product} onAdd={openQuickAdd} busy={busy} />
                  ))}
                  {visibleProducts.length === 0 && <p className="empty-state">No products match your search.</p>}
                </div>
              )}
            </section>
          </>
        )}

        {currentPage === 'cart' && (
          <section className="section narrow">
            <span className="eyebrow">YOUR ORDER</span><h1>Your cart</h1>
            {cartEntries.length === 0 ? (
              <><p className="muted">Your cart is empty.</p><button className="button" onClick={() => setPage('shop')}>Browse the menu</button></>
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
                <Totals subtotal={subtotal} deliveryFee={deliveryFee} total={total} />
                <button className="button full" onClick={() => setPage(profile ? 'checkout' : 'account')}>Continue to checkout</button>
              </>
            )}
          </section>
        )}

        {currentPage === 'checkout' && (
          <section className="section checkout-page">
            {!profile ? <p>Please sign in to check out.</p> : cartEntries.length === 0 ? (
              <>
                <span className="eyebrow">YOUR ORDER</span>
                <h1>Checkout</h1>
                <p className="muted">Your cart is empty.</p>
                <button className="button" onClick={() => setPage('shop')}>Browse the menu</button>
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
                          <textarea
                            name="shipping_address"
                            autoComplete="shipping street-address"
                            placeholder="House number, street, barangay, city"
                            rows={3}
                            required
                            maxLength={500}
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
                    <Totals subtotal={subtotal} deliveryFee={deliveryFee} total={total} />
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

        {currentPage === 'account' && (
          <section className={`section ${profile ? 'account-page' : 'narrow auth-section'}`}>
            {!profile && <span className="eyebrow">WELCOME TO TASA</span>}
            {!profile ? (
              <>
                <h1>{authMode === 'login' ? 'Log in to Tasa' : 'Create your account'}</h1>
                <p className="muted">
                  {authMode === 'login'
                    ? 'Sign in to continue to the storefront.'
                    : 'Join Tasa to browse the menu and place an order.'}
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
                        <button className="button" type="button" onClick={() => setPage('shop')}>Shop the menu</button>
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
                    editingProduct={editingProduct}
                    setEditingProduct={setEditingProduct}
                    onSave={saveProduct}
                    onToggle={toggleProduct}
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
                {staffTab === 'Reports' && <Reports orders={orders} products={products} />}
              </>
            )}
          </section>
        )}
      </main>

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
              <label className="option-label" htmlFor="quick-add-option">
                Choose an option
                <select
                  id="quick-add-option"
                  value={quickAddOption}
                  autoFocus
                  onChange={(event) => setQuickAddOption(event.target.value)}
                  disabled={optionsFor(quickAddProduct.category).length === 1}
                >
                  {optionsFor(quickAddProduct.category).map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
              </label>
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
                  Total: {money(optionPrice(quickAddProduct, quickAddOption) * quickAddQuantity)}
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
                disabled={quickAddQuantity > quickAddRemaining}
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

      <footer className="site-footer">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setPage(session ? 'shop' : 'account') }}>
          <span className="brand-mark" aria-hidden="true">☕</span><span>Tasa</span>
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

function Totals({ subtotal, deliveryFee, total }: { subtotal: number; deliveryFee: number; total: number }) {
  return (
    <div className="totals">
      <div><span>Subtotal</span><strong>{money(subtotal)}</strong></div>
      <div><span>Delivery {deliveryFee === 0 ? '(free over ₱1,000)' : ''}</span><strong>{money(deliveryFee)}</strong></div>
      <div className="total"><span>Total</span><strong>{money(total)}</strong></div>
    </div>
  )
}

function Inventory({
  products,
  editingProduct,
  setEditingProduct,
  onSave,
  onToggle,
  busy,
}: {
  products: Product[]
  editingProduct: Product | null
  setEditingProduct: (product: Product | null) => void
  onSave: (event: FormEvent<HTMLFormElement>) => void
  onToggle: (product: Product) => void
  busy: boolean
}) {
  return (
    <>
      <form className="form-card inventory-form" key={editingProduct?.id ?? 'new'} onSubmit={onSave}>
        <h2>{editingProduct ? 'Edit product' : 'Add product'}</h2>
        <label>Name<input name="name" required maxLength={160} defaultValue={editingProduct?.name ?? ''} /></label>
        <label>Category<select name="category" defaultValue={editingProduct?.category ?? 'Beans'}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>Description<input name="description" maxLength={1000} defaultValue={editingProduct?.description ?? ''} /></label>
        <label>Price (₱)<input type="number" name="price" min="0" step="0.01" required defaultValue={editingProduct?.price ?? ''} /></label>
        <label>Stock<input type="number" name="stock" min="0" step="1" required defaultValue={editingProduct?.stock ?? ''} /></label>
        <label>Image URL<input type="url" name="image_url" placeholder="https://…" defaultValue={editingProduct?.image_url ?? ''} /></label>
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
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
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

function Reports({ orders, products }: { orders: OrderView[]; products: Product[] }) {
  const completed = orders.filter((order) => !['Cancelled', 'Returned'].includes(order.status))
  const revenue = completed.reduce((sum, order) => sum + Number(order.total), 0)
  const sold = new Map<string, number>()
  completed.forEach((order) =>
    order.items.forEach((item) => sold.set(item.product_name, (sold.get(item.product_name) ?? 0) + item.quantity)),
  )
  const topProducts = [...sold.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5)
  const lowStock = products.filter((product) => product.active && product.stock < 10)

  return (
    <>
      <div className="stats">
        <article className="stat-card"><span className="muted">Revenue*</span><strong>{money(revenue)}</strong></article>
        <article className="stat-card"><span className="muted">Orders</span><strong>{orders.length}</strong></article>
      </div>
      <p className="muted">*Excludes cancelled and returned orders.</p>
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
