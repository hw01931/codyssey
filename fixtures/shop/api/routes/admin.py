from fastapi import APIRouter
from services.order import list_orders
from services.payment import total_revenue

router = APIRouter()

@router.get("/stats")
def get_stats():
    return {"orders": len(list_orders()), "revenue": total_revenue()}
