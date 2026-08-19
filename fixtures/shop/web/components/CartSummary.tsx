import { PriceRow } from './PriceRow'

export function CartSummary({ onPay }) {
  return <div><PriceRow amount={1000} /><button onClick={onPay}>pay</button></div>
}
