from db.models import Payment
from services.money import to_cents

def charge(amount: int):
    return Payment.create(amount=to_cents(amount))

def total_revenue():
    return sum(p.amount for p in Payment.all())
