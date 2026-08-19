from fastapi import FastAPI
from routes import orders, payments, admin

app = FastAPI()
app.include_router(orders.router, prefix="/api/v1")
app.include_router(payments.router, prefix="/api/v1")
app.include_router(admin.router, prefix="/api/v1/admin")
