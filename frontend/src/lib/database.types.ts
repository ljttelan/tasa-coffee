export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Role = 'customer' | 'fulfillment' | 'staff' | 'admin'
export type Category = string
export type OrderStatus =
  | 'Pending'
  | 'Packing'
  | 'Out for delivery'
  | 'Delivered'
  | 'Cancelled'
  | 'Returned'
export type ReturnStatus = 'None' | 'Requested' | 'Approved' | 'Rejected'
export type RefundStatus = 'Not requested' | 'Mock refund processed' | 'Not applicable'

export type Profile = {
  id: string
  name: string
  email: string
  role: Role
  created_at: string
}

export type Product = {
  id: string
  name: string
  category: Category
  description: string
  price: number
  stock: number
  image_url: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export type ProductCategory = {
  name: Category
  active: boolean
  created_at: string
}

export type ProductVariant = {
  id: string
  product_id: string
  name: string
  price_delta: number
  active: boolean
  sort_order: number
  created_at: string
}

export type CustomerAddress = {
  id: string
  user_id: string
  label: string
  full_address: string
  is_default: boolean
  created_at: string
}

export type StoreEvent = {
  id: string
  visitor_id: string
  user_id: string | null
  event_type: 'catalog_view' | 'add_to_cart' | 'checkout_started' | 'order_placed' | 'order_abandoned'
  product_id: string | null
  created_at: string
}

export type Order = {
  id: string
  user_id: string
  customer_name: string
  phone: string
  billing_address: string
  shipping_address: string
  payment_method: 'GCash (mock)' | 'Card (mock)' | 'Cash on delivery'
  status: OrderStatus
  return_status: ReturnStatus
  refund_status: RefundStatus
  coupon_code: string | null
  discount_amount: number
  courier_id: string | null
  tracking_number: string | null
  subtotal: number
  delivery_fee: number
  total: number
  created_at: string
  updated_at: string
}

export type OrderItem = {
  id: string
  order_id: string
  product_id: string | null
  product_name: string
  product_option: string
  quantity: number
  unit_price: number
  created_at: string
}

export type TrackedOrder = Pick<
  Order,
  | 'id'
  | 'created_at'
  | 'status'
  | 'tracking_number'
  | 'shipping_address'
  | 'payment_method'
  | 'subtotal'
  | 'delivery_fee'
  | 'total'
> & {
  courier_name: string | null
  items: Array<Pick<OrderItem, 'product_name' | 'product_option' | 'quantity' | 'unit_price'>>
}

type Table<Row, Insert, Update> = {
  Row: Row
  Insert: Insert
  Update: Update
  Relationships: []
}

export type Database = {
  public: {
    Tables: {
      profiles: Table<
        Profile,
        Omit<Profile, 'created_at' | 'role'> & { created_at?: string; role?: Role },
        Partial<Omit<Profile, 'id' | 'created_at'>>
      >
      products: Table<
        Product,
        Omit<Product, 'id' | 'created_at' | 'updated_at' | 'active'> & {
          id?: string
          created_at?: string
          updated_at?: string
          active?: boolean
        },
        Partial<Omit<Product, 'id' | 'created_at'>>
      >
      product_categories: Table<
        ProductCategory,
        Omit<ProductCategory, 'created_at' | 'active'> & { created_at?: string; active?: boolean },
        Partial<Omit<ProductCategory, 'name' | 'created_at'>>
      >
      product_variants: Table<
        ProductVariant,
        Omit<ProductVariant, 'id' | 'created_at' | 'active' | 'sort_order'> & {
          id?: string
          created_at?: string
          active?: boolean
          sort_order?: number
        },
        Partial<Omit<ProductVariant, 'id' | 'product_id' | 'created_at'>>
      >
      customer_addresses: Table<
        CustomerAddress,
        Omit<CustomerAddress, 'id' | 'created_at' | 'is_default'> & {
          id?: string
          created_at?: string
          is_default?: boolean
        },
        Partial<Omit<CustomerAddress, 'id' | 'user_id' | 'created_at'>>
      >
      store_events: Table<
        StoreEvent,
        Omit<StoreEvent, 'id' | 'created_at'> & { id?: string; created_at?: string },
        Partial<Omit<StoreEvent, 'id' | 'visitor_id' | 'user_id' | 'created_at'>>
      >
      coupons: Table<
        {
          code: string
          discount_type: 'percent' | 'fixed'
          discount_value: number
          min_subtotal: number
          max_uses: number | null
          uses: number
          valid_from: string | null
          valid_until: string | null
          active: boolean
          created_at: string
        },
        {
          code: string
          discount_type: 'percent' | 'fixed'
          discount_value: number
          min_subtotal?: number
          max_uses?: number | null
          uses?: number
          valid_from?: string | null
          valid_until?: string | null
          active?: boolean
          created_at?: string
        },
        Partial<{
          discount_type: 'percent' | 'fixed'
          discount_value: number
          min_subtotal: number
          max_uses: number | null
          uses: number
          valid_from: string | null
          valid_until: string | null
          active: boolean
        }>
      >
      orders: Table<
        Order,
        Omit<Order, 'id' | 'created_at' | 'updated_at'> & {
          id?: string
          created_at?: string
          updated_at?: string
        },
        Partial<Omit<Order, 'id' | 'user_id' | 'created_at'>>
      >
      order_items: Table<
        OrderItem,
        Omit<OrderItem, 'id' | 'created_at'> & { id?: string; created_at?: string },
        Partial<Omit<OrderItem, 'id' | 'created_at'>>
      >
    }
    Views: Record<string, never>
    Functions: {
      place_order: {
        Args: {
          p_customer_name: string
          p_phone: string
          p_billing_address: string
          p_shipping_address: string
          p_payment_method: Order['payment_method']
          p_items: Json
          p_coupon_code: string | null
        }
        Returns: string
      }
      update_my_profile: { Args: { p_name: string }; Returns: undefined }
      set_default_address: { Args: { p_address_id: string }; Returns: undefined }
      quote_coupon: { Args: { p_code: string; p_subtotal: number }; Returns: number }
      assign_courier: {
        Args: { p_order_id: string; p_courier_id: string | null }
        Returns: undefined
      }
      set_tracking_number: {
        Args: { p_order_id: string; p_tracking_number: string | null }
        Returns: undefined
      }
      cancel_order: { Args: { p_order_id: string }; Returns: undefined }
      request_return: { Args: { p_order_id: string }; Returns: undefined }
      set_order_status: {
        Args: { p_order_id: string; p_status: OrderStatus }
        Returns: undefined
      }
      review_return: {
        Args: { p_order_id: string; p_decision: 'Approved' | 'Rejected' }
        Returns: undefined
      }
      track_order: { Args: { p_order_number: string }; Returns: TrackedOrder[] }
      get_product_popularity: {
        Args: Record<string, never>
        Returns: { product_id: string; popularity: number }[]
      }
      get_my_role: { Args: Record<string, never>; Returns: string }
      is_staff: { Args: Record<string, never>; Returns: boolean }
      is_admin: { Args: Record<string, never>; Returns: boolean }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
