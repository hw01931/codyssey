import { CartSummary } from '@/components/CartSummary'
import { createPayment } from '@/lib/api'

export default function CheckoutPage() {
  return <CartSummary onPay={createPayment} />
}
