export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Role = 'customer' | 'fulfillment' | 'staff' | 'admin'
export type Category = 'Beans' | 'Brewed' | 'Pastries' | 'Merch'
export type OrderStatus =
  | 'Pending'
  | 'Packing'
  | 'Out for delivery'
  | 'Delivered'
  | 'Cancelled'
  | 'Returned'
export type ReturnStatus = 'None' | 'Requested' | 'Approved' | 'Rejected'

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
        }
        Returns: string
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
      get_my_role: { Args: Record<string, never>; Returns: string }
      is_staff: { Args: Record<string, never>; Returns: boolean }
      is_admin: { Args: Record<string, never>; Returns: boolean }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
