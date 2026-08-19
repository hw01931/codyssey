import { fetchOrders } from '@/lib/api'
import { formatMoney } from '@/lib/money'

export function OrderTable() {
  const orders = fetchOrders()
  return <table>{orders.map(o => <tr>{formatMoney(o.total)}</tr>)}</table>
}
