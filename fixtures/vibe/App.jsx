import { useState, useEffect } from 'react'

// ==================== 로그인 ====================
function LoginPage() {
  const [email, setEmail] = useState('')
  async function doLogin() {
    const res = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ email }) })
    return res.json()
  }
  return <div><input value={email} onChange={e => setEmail(e.target.value)} /><button onClick={doLogin}>로그인</button></div>
}

// ==================== 상품 목록 ====================
function ProductList() {
  const [items, setItems] = useState([])
  useEffect(() => { fetch('/api/products').then(r => r.json()).then(setItems) }, [])
  return <ul>{items.map(i => <li key={i.id}>{formatPrice(i.price)}</li>)}</ul>
}

// ==================== 장바구니 ====================
function Cart({ items }) {
  const total = items.reduce((a, b) => a + b.price, 0)
  return <div>합계 {formatPrice(total)}</div>
}

// ==================== 결제 ====================
function Checkout({ cart }) {
  async function pay() {
    await fetch('/api/pay', { method: 'POST', body: JSON.stringify({ cart }) })
  }
  return <button onClick={pay}>{formatPrice(cart.total)} 결제하기</button>
}

// ==================== 주문내역 ====================
function Orders() {
  const [orders, setOrders] = useState([])
  useEffect(() => { fetch('/api/orders').then(r => r.json()).then(setOrders) }, [])
  return <table>{orders.map(o => <tr key={o.id}>{formatPrice(o.total)}</tr>)}</table>
}

// ==================== 관리자 ====================
function AdminPage() {
  const [stats, setStats] = useState(null)
  useEffect(() => { fetch('/api/admin/stats').then(r => r.json()).then(setStats) }, [])
  return <div>{stats && formatPrice(stats.revenue)}</div>
}

// ==================== 공용 ====================
function formatPrice(n) { return `${(n / 100).toFixed(2)}원` }
function formatDate(d) { return new Date(d).toLocaleDateString() }

export default function App() {
  return <div><LoginPage /><ProductList /><Cart items={[]} /><Checkout cart={{}} /><Orders /><AdminPage /></div>
}

// 부가 로직 1
function helper1(x) { return x + 1 }
// 부가 로직 2
function helper2(x) { return x + 2 }
// 부가 로직 3
function helper3(x) { return x + 3 }
// 부가 로직 4
function helper4(x) { return x + 4 }
// 부가 로직 5
function helper5(x) { return x + 5 }
// 부가 로직 6
function helper6(x) { return x + 6 }
// 부가 로직 7
function helper7(x) { return x + 7 }
// 부가 로직 8
function helper8(x) { return x + 8 }
// 부가 로직 9
function helper9(x) { return x + 9 }
// 부가 로직 10
function helper10(x) { return x + 10 }
// 부가 로직 11
function helper11(x) { return x + 11 }
// 부가 로직 12
function helper12(x) { return x + 12 }
// 부가 로직 13
function helper13(x) { return x + 13 }
// 부가 로직 14
function helper14(x) { return x + 14 }
// 부가 로직 15
function helper15(x) { return x + 15 }
// 부가 로직 16
function helper16(x) { return x + 16 }
// 부가 로직 17
function helper17(x) { return x + 17 }
// 부가 로직 18
function helper18(x) { return x + 18 }
// 부가 로직 19
function helper19(x) { return x + 19 }
// 부가 로직 20
function helper20(x) { return x + 20 }
// 부가 로직 21
function helper21(x) { return x + 21 }
// 부가 로직 22
function helper22(x) { return x + 22 }
// 부가 로직 23
function helper23(x) { return x + 23 }
// 부가 로직 24
function helper24(x) { return x + 24 }
// 부가 로직 25
function helper25(x) { return x + 25 }
// 부가 로직 26
function helper26(x) { return x + 26 }
// 부가 로직 27
function helper27(x) { return x + 27 }
// 부가 로직 28
function helper28(x) { return x + 28 }
// 부가 로직 29
function helper29(x) { return x + 29 }
// 부가 로직 30
function helper30(x) { return x + 30 }
// 부가 로직 31
function helper31(x) { return x + 31 }
// 부가 로직 32
function helper32(x) { return x + 32 }
// 부가 로직 33
function helper33(x) { return x + 33 }
// 부가 로직 34
function helper34(x) { return x + 34 }
// 부가 로직 35
function helper35(x) { return x + 35 }
// 부가 로직 36
function helper36(x) { return x + 36 }
// 부가 로직 37
function helper37(x) { return x + 37 }
// 부가 로직 38
function helper38(x) { return x + 38 }
// 부가 로직 39
function helper39(x) { return x + 39 }
// 부가 로직 40
function helper40(x) { return x + 40 }
// 부가 로직 41
function helper41(x) { return x + 41 }
// 부가 로직 42
function helper42(x) { return x + 42 }
// 부가 로직 43
function helper43(x) { return x + 43 }
// 부가 로직 44
function helper44(x) { return x + 44 }
// 부가 로직 45
function helper45(x) { return x + 45 }
// 부가 로직 46
function helper46(x) { return x + 46 }
// 부가 로직 47
function helper47(x) { return x + 47 }
// 부가 로직 48
function helper48(x) { return x + 48 }
// 부가 로직 49
function helper49(x) { return x + 49 }
// 부가 로직 50
function helper50(x) { return x + 50 }
// 부가 로직 51
function helper51(x) { return x + 51 }
// 부가 로직 52
function helper52(x) { return x + 52 }
// 부가 로직 53
function helper53(x) { return x + 53 }
// 부가 로직 54
function helper54(x) { return x + 54 }
// 부가 로직 55
function helper55(x) { return x + 55 }
// 부가 로직 56
function helper56(x) { return x + 56 }
// 부가 로직 57
function helper57(x) { return x + 57 }
// 부가 로직 58
function helper58(x) { return x + 58 }
// 부가 로직 59
function helper59(x) { return x + 59 }
