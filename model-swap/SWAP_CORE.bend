# CORE fills the exact open SWAP_LAWS.begin/step interfaces; SWAP_PROOF imports
# this module so the checked functions are the ones the laws mention.
#
# Reduction note: the fact columns (qualified, active) are matched before the
# identity columns, so laws with host-proven facts reduce without a 6x6 identity
# case split. This is a proof-shape choice, not a policy change.
#
# Uncertain is a barrier: a failed physical proof is not cleared by a fresh
# identity probe. Only Recover (host-proven clean state) clears it. Fresh
# startup Unknown remains adoptable.
import Base
import ./SWAP_LAWS.bend as L

def L.begin():
  L.State{L.Unknown{}, L.Idle{}}

# Facts first: an in-flight ordinary request, then qualification, then identity.
# No priority argument exists here.
def admit(a: Bool, q: Bool, r: L.Residency, +m: L.Model) -> L.Reply:
  match a:
    case True{}:
      L.Reply{L.State{r, L.Idle{}}, L.Wait{}}
    case False{}:
      match q:
        case False{}:
          L.Reply{L.State{r, L.Idle{}}, L.Refuse{}}
        case True{}:
          match r:
            case L.Unknown{}:
              L.Reply{L.State{L.Unknown{}, L.Idle{}}, L.Refuse{}}
            case L.Uncertain{}:
              L.Reply{L.State{L.Uncertain{}, L.Idle{}}, L.Refuse{}}
            case L.Empty{}:
              L.Reply{L.State{L.Empty{}, L.Starting{m}}, L.Start{m}}
            case L.Loaded{+x}:
              Bool.pick(L.Reply, L.model_eq(x, m),
                L.Reply{L.State{L.Loaded{x}, L.Idle{}}, L.Reuse{}},
                L.Reply{L.State{L.Loaded{x}, L.Stopping{m, x}}, L.Stop{x}})

def idle(a: Bool, e: Nat, t: Nat, r: L.Residency) -> L.Reply:
  match a:
    case True{}:
      L.Reply{L.State{r, L.Idle{}}, L.Keep{}}
    case False{}:
      match r:
        case L.Empty{}:
          L.Reply{L.State{L.Empty{}, L.Idle{}}, L.Keep{}}
        case L.Unknown{}:
          L.Reply{L.State{L.Unknown{}, L.Idle{}}, L.Keep{}}
        case L.Uncertain{}:
          L.Reply{L.State{L.Uncertain{}, L.Idle{}}, L.Keep{}}
        case L.Loaded{+m}:
          Bool.pick(L.Reply, Nat.is_ge(e, t),
            Bool.pick(L.Reply, L.model_sticky(m),
              L.Reply{L.State{L.Loaded{m}, L.Idle{}}, L.Keep{}},
              L.Reply{L.State{L.Loaded{m}, L.Idle{}}, L.Unload{m}}),
            L.Reply{L.State{L.Loaded{m}, L.Idle{}}, L.Keep{}})

# The transition table is total. A transition in progress is inert for every
# other event; only a host-proven stop or ready observation advances it.
def L.step(s, e):
  match s e:
    case L.State{L.Uncertain{}, L.Idle{}} L.Recover{}:
      L.Reply{L.State{L.Empty{}, L.Idle{}}, L.NoAction{}}
    case L.State{L.Uncertain{}, L.Idle{}} L.Admit{m, q, True{}}:
      L.Reply{L.State{L.Uncertain{}, L.Idle{}}, L.Wait{}}
    case L.State{L.Uncertain{}, L.Idle{}} L.Admit{m, q, False{}}:
      L.Reply{L.State{L.Uncertain{}, L.Idle{}}, L.Refuse{}}
    case L.State{L.Uncertain{}, L.Idle{}} L.IdleTick{e2, t, a}:
      L.Reply{L.State{L.Uncertain{}, L.Idle{}}, L.Keep{}}
    case L.State{L.Uncertain{}, L.Idle{}} e:
      L.Reply{L.State{L.Uncertain{}, L.Idle{}}, L.NoAction{}}
    case L.State{r, L.Idle{}} L.Recover{}:
      L.Reply{L.State{L.Empty{}, L.Idle{}}, L.NoAction{}}
    case L.State{r, L.Idle{}} L.Admit{m, q, a}:
      admit(a, q, r, m)
    case L.State{r, L.Idle{}} L.IdleTick{e2, t, a}:
      idle(a, e2, t, r)
    case L.State{r, L.Idle{}} L.Adopt{m}:
      L.Reply{L.State{L.Loaded{m}, L.Idle{}}, L.NoAction{}}
    case L.State{r, L.Idle{}} L.AdoptEmpty{}:
      L.Reply{L.State{L.Empty{}, L.Idle{}}, L.NoAction{}}
    case L.State{r, L.Idle{}} L.AdoptUnknown{}:
      L.Reply{L.State{L.Unknown{}, L.Idle{}}, L.NoAction{}}
    case L.State{r, L.Idle{}} L.ReleaseDone{}:
      L.Reply{L.State{L.Empty{}, L.Idle{}}, L.NoAction{}}
    case L.State{r, L.Idle{}} L.ReleaseUnknown{}:
      L.Reply{L.State{L.Uncertain{}, L.Idle{}}, L.NoAction{}}
    case L.State{r, L.Idle{}} e:
      L.Reply{L.State{r, L.Idle{}}, L.NoAction{}}
    case L.State{r, L.Stopping{+m, x}} L.StopDone{}:
      L.Reply{L.State{L.Empty{}, L.Starting{m}}, L.Start{m}}
    case L.State{r, L.Stopping{+m, +x}} L.Abort{}:
      L.Reply{L.State{L.Loaded{x}, L.Idle{}}, L.NoAction{}}
    case L.State{r, L.Stopping{m, x}} L.StopUnknown{}:
      L.Reply{L.State{L.Uncertain{}, L.Idle{}}, L.Refuse{}}
    case L.State{r, L.Stopping{m, +x}} e:
      L.Reply{L.State{L.Loaded{x}, L.Stopping{m, x}}, L.NoAction{}}
    case L.State{r, L.Starting{m}} L.StartReady{}:
      L.Reply{L.State{L.Loaded{m}, L.Idle{}}, L.NoAction{}}
    case L.State{r, L.Starting{m}} L.StartUnknown{}:
      L.Reply{L.State{L.Uncertain{}, L.Idle{}}, L.Refuse{}}
    case L.State{r, L.Starting{m}} e:
      L.Reply{L.State{L.Empty{}, L.Starting{m}}, L.NoAction{}}
