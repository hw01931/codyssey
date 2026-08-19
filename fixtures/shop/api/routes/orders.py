from fastapi import APIRouter
from services.order import list_orders

router = APIRouter()

@router.get("/orders")
def get_orders():
    return list_orders()
