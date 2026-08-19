import { OrderTable } from '@/components/OrderTable'
import { formatMoney } from '@/lib/money'

export default function AdminPage() {
  return <div>{formatMoney(0)}<OrderTable /></div>
}
