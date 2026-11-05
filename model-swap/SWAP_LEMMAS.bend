# Small proof helpers copied from the already-checked coordinator LEMMAS.bend
# (same names and shapes); nothing here chooses a swap.
import Base
import ./SWAP_LAWS.bend as L

def bool_disc(b: Bool) -> Type:
  match b:
    case False{}: Unit
    case True{}: Empty

def false_true(e: {False{} == True{} : Bool}) -> Empty:
  %e : bool_disc(_)
  Unit{}

def not_true(+b: Bool, h: {Bool.not(b) == True{} : Bool}) -> {b == False{} : Bool}:
  match b:
    case False{}: {==}
    case True{}: Empty.absurd({True{} == False{} : Bool}, false_true(h))

def pick_true(-A: Type, +b: Bool, -t: A, -f: A, h: {b == True{} : Bool}) -> {Bool.pick(A, b, t, f) == t : A}:
  %Equal.sym(Bool, b, True{}, h) : {Bool.pick(A, _, t, f) == t : A}
  {==}

def pick_false(-A: Type, +b: Bool, -t: A, -f: A, h: {b == False{} : Bool}) -> {Bool.pick(A, b, t, f) == f : A}:
  %Equal.sym(Bool, b, False{}, h) : {Bool.pick(A, _, t, f) == f : A}
  {==}

def cmp_not_lt(+c: Cmp) -> {Cmp.is_ge(c) == Bool.not(Cmp.is_lt(c)) : Bool}:
  match c:
    case LT{}: {==}
    case EQ{}: {==}
    case GT{}: {==}

def lt_not_ge(+a: Nat, +b: Nat, h: {Nat.is_lt(a, b) == True{} : Bool}) -> {Nat.is_ge(a, b) == False{} : Bool}:
  Equal.trans(Bool, Nat.is_ge(a, b), Bool.not(Nat.is_lt(a, b)), False{},
    cmp_not_lt(Nat.cmp(a, b)),
    Equal.cong(Bool, Bool, x => Bool.not(x), Nat.is_lt(a, b), True{}, h))

def model_eq_refl(+m: L.Model) -> {L.model_eq(m, m) == True{} : Bool}:
  match m:
    case L.Ds4Qwen{}: {==}
    case L.Ds4V41{}: {==}
    case L.Ds4Glm{}: {==}
    case L.MlxQwen{}: {==}
    case L.MlxGemma{}: {==}
    case L.StartLux{}: {==}
    case L.MlxQwen4B8Bit{}: {==}
    case L.MlxQwen4BBF16{}: {==}
    case L.MlxQwen4BAbl{}: {==}
    case L.MlxWriterBF16{}: {==}
