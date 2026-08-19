import { formatMoney } from '@/lib/money'

export function PriceRow({ amount }) {
  return <span>{formatMoney(amount)}</span>
}
