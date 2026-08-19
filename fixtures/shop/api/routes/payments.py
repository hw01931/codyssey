from fastapi import APIRouter
from services.payment import charge

router = APIRouter()

@router.post("/payments")
def post_payment(amount: int):
    return charge(amount)
