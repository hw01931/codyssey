export async function fetchOrders() {
  const res = await fetch('/api/v1/orders')
  return res.json()
}

export async function createPayment(amount: number) {
  return fetch('/api/v1/payments', { method: 'POST', body: JSON.stringify({ amount }) })
}

export async function fetchStats() {
  return fetch(`/api/v1/admin/stats`)
}
