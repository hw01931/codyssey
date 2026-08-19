class Order:
    id: int
    total: float
    @classmethod
    def all(cls): return []

class Payment:
    amount: int
    @classmethod
    def all(cls): return []
    @classmethod
    def create(cls, amount): return cls()
