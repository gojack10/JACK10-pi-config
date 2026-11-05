# SWAP_PROOF closes every law in SWAP_LAWS. Each def has the law's parameters
# and the law's exact equality type after the CORE definitions normalize.
import Base
import ./SWAP_LAWS.bend as Laws
import ./SWAP_CORE.bend as C
import ./SWAP_LEMMAS.bend as H

def Laws.reuse_same(r):
  H.pick_true(Laws.Reply, Laws.model_eq(r, r),
    Laws.Reply{Laws.State{Laws.Loaded{r}, Laws.Idle{}}, Laws.Reuse{}},
    Laws.Reply{Laws.State{Laws.Loaded{r}, Laws.Stopping{r, r}}, Laws.Stop{r}},
    H.model_eq_refl(r))

def Laws.refuse_unqualified(r, m):
  match r:
    case Laws.Empty{}:
      {==}
    case Laws.Loaded{x}:
      {==}
    case Laws.Unknown{}:
      {==}
    case Laws.Uncertain{}:
      {==}

def Laws.refuse_unknown(m):
  {==}

def Laws.refuse_uncertain(m):
  {==}

def Laws.wait_active(r, m, q):
  match r:
    case Laws.Empty{}:
      {==}
    case Laws.Loaded{x}:
      {==}
    case Laws.Unknown{}:
      {==}
    case Laws.Uncertain{}:
      {==}

def Laws.start_empty(m):
  {==}

def Laws.swap_stops_first(r, m, ne):
  H.pick_false(Laws.Reply, Laws.model_eq(r, m),
    Laws.Reply{Laws.State{Laws.Loaded{r}, Laws.Idle{}}, Laws.Reuse{}},
    Laws.Reply{Laws.State{Laws.Loaded{r}, Laws.Stopping{m, r}}, Laws.Stop{r}},
    H.not_true(Laws.model_eq(r, m), ne))

def Laws.stop_done_starts(m, r):
  {==}

def Laws.start_ready_adopts(m):
  {==}

def Laws.stop_unknown_fails(m, r):
  {==}

def Laws.start_unknown_fails(m):
  {==}

def Laws.adopt_replaces(r, m, ok):
  match r:
    case Laws.Empty{}:
      {==}
    case Laws.Loaded{x}:
      {==}
    case Laws.Unknown{}:
      {==}
    case Laws.Uncertain{}:
      Empty.absurd({Laws.step(Laws.State{Laws.Uncertain{}, Laws.Idle{}}, Laws.Adopt{m}) ==
                    Laws.Reply{Laws.State{Laws.Loaded{m}, Laws.Idle{}}, Laws.NoAction{}} : Laws.Reply},
                   H.false_true(ok))

def Laws.adopt_uncertain_inert(m):
  {==}

def Laws.adopt_empty_clears(r, ok):
  match r:
    case Laws.Empty{}:
      {==}
    case Laws.Loaded{x}:
      {==}
    case Laws.Unknown{}:
      {==}
    case Laws.Uncertain{}:
      Empty.absurd({Laws.step(Laws.State{Laws.Uncertain{}, Laws.Idle{}}, Laws.AdoptEmpty{}) ==
                    Laws.Reply{Laws.State{Laws.Empty{}, Laws.Idle{}}, Laws.NoAction{}} : Laws.Reply},
                   H.false_true(ok))

def Laws.adopt_empty_uncertain_inert():
  {==}

def Laws.adopt_unknown_fails(r, ok):
  match r:
    case Laws.Empty{}:
      {==}
    case Laws.Loaded{x}:
      {==}
    case Laws.Unknown{}:
      {==}
    case Laws.Uncertain{}:
      Empty.absurd({Laws.step(Laws.State{Laws.Uncertain{}, Laws.Idle{}}, Laws.AdoptUnknown{}) ==
                    Laws.Reply{Laws.State{Laws.Unknown{}, Laws.Idle{}}, Laws.NoAction{}} : Laws.Reply},
                   H.false_true(ok))

def Laws.adopt_unknown_uncertain_inert():
  {==}

def Laws.sticky_keeps(e, t, due):
  H.pick_true(Laws.Reply, Nat.is_ge(e, t),
    Bool.pick(Laws.Reply, Laws.model_sticky(Laws.StartLux{}),
      Laws.Reply{Laws.State{Laws.Loaded{Laws.StartLux{}}, Laws.Idle{}}, Laws.Keep{}},
      Laws.Reply{Laws.State{Laws.Loaded{Laws.StartLux{}}, Laws.Idle{}}, Laws.Unload{Laws.StartLux{}}}),
    Laws.Reply{Laws.State{Laws.Loaded{Laws.StartLux{}}, Laws.Idle{}}, Laws.Keep{}},
    due)

def Laws.idle_unloads(m, e, t, due, chat):
  Equal.trans(Laws.Reply,
    Bool.pick(Laws.Reply, Nat.is_ge(e, t),
      Bool.pick(Laws.Reply, Laws.model_sticky(m),
        Laws.Reply{Laws.State{Laws.Loaded{m}, Laws.Idle{}}, Laws.Keep{}},
        Laws.Reply{Laws.State{Laws.Loaded{m}, Laws.Idle{}}, Laws.Unload{m}}),
      Laws.Reply{Laws.State{Laws.Loaded{m}, Laws.Idle{}}, Laws.Keep{}}),
    Bool.pick(Laws.Reply, Laws.model_sticky(m),
      Laws.Reply{Laws.State{Laws.Loaded{m}, Laws.Idle{}}, Laws.Keep{}},
      Laws.Reply{Laws.State{Laws.Loaded{m}, Laws.Idle{}}, Laws.Unload{m}}),
    Laws.Reply{Laws.State{Laws.Loaded{m}, Laws.Idle{}}, Laws.Unload{m}},
    H.pick_true(Laws.Reply, Nat.is_ge(e, t),
      Bool.pick(Laws.Reply, Laws.model_sticky(m),
        Laws.Reply{Laws.State{Laws.Loaded{m}, Laws.Idle{}}, Laws.Keep{}},
        Laws.Reply{Laws.State{Laws.Loaded{m}, Laws.Idle{}}, Laws.Unload{m}}),
      Laws.Reply{Laws.State{Laws.Loaded{m}, Laws.Idle{}}, Laws.Keep{}}, due),
    H.pick_false(Laws.Reply, Laws.model_sticky(m),
      Laws.Reply{Laws.State{Laws.Loaded{m}, Laws.Idle{}}, Laws.Keep{}},
      Laws.Reply{Laws.State{Laws.Loaded{m}, Laws.Idle{}}, Laws.Unload{m}}, chat))

def Laws.idle_early_keeps(r, e, t, early):
  match r:
    case Laws.Empty{}:
      {==}
    case Laws.Unknown{}:
      {==}
    case Laws.Uncertain{}:
      {==}
    case Laws.Loaded{m}:
      H.pick_false(Laws.Reply, Nat.is_ge(e, t),
        Bool.pick(Laws.Reply, Laws.model_sticky(m),
          Laws.Reply{Laws.State{Laws.Loaded{m}, Laws.Idle{}}, Laws.Keep{}},
          Laws.Reply{Laws.State{Laws.Loaded{m}, Laws.Idle{}}, Laws.Unload{m}}),
        Laws.Reply{Laws.State{Laws.Loaded{m}, Laws.Idle{}}, Laws.Keep{}},
        H.lt_not_ge(e, t, early))

def Laws.idle_active_keeps(r, e, t):
  match r:
    case Laws.Empty{}:
      {==}
    case Laws.Unknown{}:
      {==}
    case Laws.Uncertain{}:
      {==}
    case Laws.Loaded{m}:
      {==}

def Laws.idle_empty_keeps(e, t):
  {==}

def Laws.idle_unknown_keeps(e, t):
  {==}

def Laws.idle_uncertain_keeps(e, t):
  {==}

def Laws.release_done_clears(m):
  {==}

def Laws.release_done_uncertain_inert():
  {==}

def Laws.release_unknown_fails(m):
  {==}

def Laws.release_unknown_uncertain_inert():
  {==}

def Laws.recover_clears(r):
  match r:
    case Laws.Empty{}:
      {==}
    case Laws.Loaded{x}:
      {==}
    case Laws.Unknown{}:
      {==}
    case Laws.Uncertain{}:
      {==}

def Laws.abort_restores(m, x):
  {==}

def Laws.abort_inert_idle(r):
  match r:
    case Laws.Empty{}:
      {==}
    case Laws.Loaded{x}:
      {==}
    case Laws.Unknown{}:
      {==}
    case Laws.Uncertain{}:
      {==}

def Laws.abort_inert_starting(m):
  {==}

def Laws.admit_inert_stopping(m, r, t, q, a):
  {==}

def Laws.admit_inert_starting(m, t, q, a):
  {==}

def Laws.stop_done_inert_idle(r):
  match r:
    case Laws.Empty{}:
      {==}
    case Laws.Loaded{x}:
      {==}
    case Laws.Unknown{}:
      {==}
    case Laws.Uncertain{}:
      {==}

def Laws.start_ready_inert_stopping(m, r):
  {==}

def Laws.stop_done_uncertain_inert():
  {==}

def Laws.start_ready_uncertain_inert():
  {==}

def Laws.begin_unknown():
  {==}
