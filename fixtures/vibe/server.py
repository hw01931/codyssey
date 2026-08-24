from fastapi import FastAPI
app = FastAPI()
DB = {}

@app.post("/api/login")
def login(email: str): return {"ok": True}

@app.get("/api/products")
def products(): return list(DB.get("products", []))

@app.post("/api/pay")
def pay(cart: dict): return {"paid": to_cents(cart.get("total", 0))}

@app.get("/api/orders")
def orders(): return list(DB.get("orders", []))

@app.get("/api/admin/stats")
def stats(): return {"revenue": to_cents(999)}

def to_cents(x): return int(round(float(x) * 100))
