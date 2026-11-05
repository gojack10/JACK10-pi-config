# Checked swap policy for proxy-owned local models (DS4, mlx-lm, decision-only
# StartLux). Host facts -- native GPU quiescence, service exit, loaded-model
# identity, chat ownership and backend readiness -- are supplied by the host;
# this core decides only reuse / stop-then-start / fail-closed release.
#
# Uncertainty is not identity. A failed stop/start/release proof enters
# Uncertain; a bare probe (Adopt) cannot clear it, only a host-proven clean
# recovery (Recover) can. Fresh startup stays adoptable from begin's Unknown.
#
# Model tags are identities, not priorities. No priority class exists here;
# ordinary FIFO admission and chat ownership stay in the host.
import Base

type Model is Data:
  Ds4Qwen{}     # 0 qwen3.8-flash-next (DS4 :8001)
  Ds4V41{}      # 1 deepseek-v4.1-flash (DS4 :8001)
  Ds4Glm{}      # 2 glm-5.3-flash (DS4, separate checkout)
  MlxQwen{}     # 3 qwen3.8-27b-uncensored (mlx-lm :8000)
  MlxGemma{}    # 4 gemma-4-31b-mlx (mlx-lm :8000)
  StartLux{}    # 5 startlux-4b-instant, decision-only (host qualification required)
  MlxQwen4B8Bit{} # 6 qwen3.5-4b-8bit (mlx-lm :8000)
  MlxQwen4BBF16{} # 7 qwen3.5-4b-bf16 (mlx-lm :8000)
  MlxQwen4BAbl{}  # 8 local abliterated 4B BF16 checkpoint (mlx-lm :8000)
  MlxWriterBF16{} # 9 local writing checkpoint (mlx-lm :8000)

type Residency is Data:
  Empty{}              # host proved no proxy-owned engine is resident
  Loaded{model: Model}
  Unknown{}            # identity not proven and nothing disturbed: probe adoption allowed
  Uncertain{}          # a stop/start/release proof failed: only Recover clears it

type Phase is Data:
  Idle{}
  Stopping{target: Model, resident: Model}   # resident stop requested; no start yet
  Starting{target: Model}                    # stop proven; start requested

type State is Data:
  State{residency: Residency, phase: Phase}

type HostEvent is Data:
  Admit{target: Model, qualified: Bool, active: Bool}
  StopDone{}                                   # host proved the resident stopped
  StopUnknown{}                                # stop proof failed
  StartReady{}                                 # host proved the target resident and ready
  StartUnknown{}                               # start proof failed
  Adopt{model: Model}                          # host probe reports an identity
  AdoptEmpty{}                                 # host proved nothing resident
  AdoptUnknown{}                               # host cannot prove identity
  ReleaseDone{}                                # idle release completed
  ReleaseUnknown{}
  Recover{}                                    # host proved a clean, supervised state
  Abort{}                                      # host refuses an authorized effect before issuing it
  IdleTick{elapsed: Nat, timeout: Nat, active: Bool}

type Action is Data:
  NoAction{}
  Wait{}                                       # active ordinary request: no transition
  Reuse{}                                      # resident already serves the target
  Stop{model: Model}
  Start{model: Model}
  Keep{}
  Unload{model: Model}
  Refuse{}                                     # fail closed, no physical effect

type Reply is Data:
  Reply{state: State, action: Action}

# Open computational interfaces; CORE fills these exact names.
law begin:
  State

law step:
  for state: State
  for event: HostEvent
  Reply

def next_state(reply: Reply) -> State:
  match reply:
    case Reply{s, a}:
      s

def action(reply: Reply) -> Action:
  match reply:
    case Reply{s, a}:
      a

def model_eq(x: Model, y: Model) -> Bool:
  match x:
    case Ds4Qwen{}:
      match y:
        case Ds4Qwen{}: True{}
        case y: False{}
    case Ds4V41{}:
      match y:
        case Ds4V41{}: True{}
        case y: False{}
    case Ds4Glm{}:
      match y:
        case Ds4Glm{}: True{}
        case y: False{}
    case MlxQwen{}:
      match y:
        case MlxQwen{}: True{}
        case y: False{}
    case MlxGemma{}:
      match y:
        case MlxGemma{}: True{}
        case y: False{}
    case StartLux{}:
      match y:
        case StartLux{}: True{}
        case y: False{}
    case MlxQwen4B8Bit{}:
      match y:
        case MlxQwen4B8Bit{}: True{}
        case y: False{}
    case MlxQwen4BBF16{}:
      match y:
        case MlxQwen4BBF16{}: True{}
        case y: False{}
    case MlxQwen4BAbl{}:
      match y:
        case MlxQwen4BAbl{}: True{}
        case y: False{}

    case MlxWriterBF16{}:
      match y:
        case MlxWriterBF16{}: True{}
        case y: False{}

def model_ne(x: Model, y: Model) -> Bool:
  Bool.not(model_eq(x, y))

# Residency property, not a priority class: StartLux is decision-only and must not
# be idle-released. Chat models keep the host's existing 30-minute idle clocks.
def model_sticky(m: Model) -> Bool:
  match m:
    case StartLux{}: True{}
    case m: False{}

# Which residencies may be (re)adopted from a mere identity probe? Uncertain is
# excluded: a failed physical proof cannot be laundered by a fresh probe.
def adoptable(r: Residency) -> Bool:
  match r:
    case Uncertain{}: False{}
    case r: True{}

# L1: a request for the already-resident model reuses it with no transition.
# This is StartLux's back-to-back decision-call residency.
law reuse_same:
  for +r: Model
  {step(State{Loaded{r}, Idle{}}, Admit{r, True{}, False{}}) ==
   Reply{State{Loaded{r}, Idle{}}, Reuse{}} : Reply}

# L2: an unqualified target is refused without touching the resident.
law refuse_unqualified:
  for +r: Residency
  for +m: Model
  {step(State{r, Idle{}}, Admit{m, False{}, False{}}) ==
   Reply{State{r, Idle{}}, Refuse{}} : Reply}

# L3: unknown resident identity refuses; never start beside a possible resident.
law refuse_unknown:
  for +m: Model
  {step(State{Unknown{}, Idle{}}, Admit{m, True{}, False{}}) ==
   Reply{State{Unknown{}, Idle{}}, Refuse{}} : Reply}

# L3b: uncertain (failed-proof) state refuses until a proven recovery.
law refuse_uncertain:
  for +m: Model
  {step(State{Uncertain{}, Idle{}}, Admit{m, True{}, False{}}) ==
   Reply{State{Uncertain{}, Idle{}}, Refuse{}} : Reply}

# L4: an active ordinary request is never preempted by a swap.
law wait_active:
  for +r: Residency
  for +m: Model
  for +q: Bool
  {step(State{r, Idle{}}, Admit{m, q, True{}}) ==
   Reply{State{r, Idle{}}, Wait{}} : Reply}

# L5: with nothing resident, a qualified target starts directly.
law start_empty:
  for +m: Model
  {step(State{Empty{}, Idle{}}, Admit{m, True{}, False{}}) ==
   Reply{State{Empty{}, Starting{m}}, Start{m}} : Reply}

# L6: a different resident is stopped first; Start cannot precede StopDone.
law swap_stops_first:
  for +r: Model
  for +m: Model
  for ne: {model_ne(r, m) == True{} : Bool}
  {step(State{Loaded{r}, Idle{}}, Admit{m, True{}, False{}}) ==
   Reply{State{Loaded{r}, Stopping{m, r}}, Stop{r}} : Reply}

# L7: only a host-proven stop starts the target.
law stop_done_starts:
  for +m: Model
  for +r: Model
  {step(State{Loaded{r}, Stopping{m, r}}, StopDone{}) ==
   Reply{State{Empty{}, Starting{m}}, Start{m}} : Reply}

# L8: a host-proven ready target becomes the sole resident.
law start_ready_adopts:
  for +m: Model
  {step(State{Empty{}, Starting{m}}, StartReady{}) ==
   Reply{State{Loaded{m}, Idle{}}, NoAction{}} : Reply}

# L9/L10: an unproven stop or start enters Uncertain, not trusted Unknown.
law stop_unknown_fails:
  for +m: Model
  for +r: Model
  {step(State{Loaded{r}, Stopping{m, r}}, StopUnknown{}) ==
   Reply{State{Uncertain{}, Idle{}}, Refuse{}} : Reply}

law start_unknown_fails:
  for +m: Model
  {step(State{Empty{}, Starting{m}}, StartUnknown{}) ==
   Reply{State{Uncertain{}, Idle{}}, Refuse{}} : Reply}

# L11: adoption records only host-proven identity, and only from an adoptable
# residency. Uncertain is not adoptable.
law adopt_replaces:
  for +r: Residency
  for +m: Model
  for ok: {adoptable(r) == True{} : Bool}
  {step(State{r, Idle{}}, Adopt{m}) ==
   Reply{State{Loaded{m}, Idle{}}, NoAction{}} : Reply}

# L11b: the anti-laundering law. A mere probe cannot clear failed-proof state.
law adopt_uncertain_inert:
  for +m: Model
  {step(State{Uncertain{}, Idle{}}, Adopt{m}) ==
   Reply{State{Uncertain{}, Idle{}}, NoAction{}} : Reply}

law adopt_empty_clears:
  for +r: Residency
  for ok: {adoptable(r) == True{} : Bool}
  {step(State{r, Idle{}}, AdoptEmpty{}) ==
   Reply{State{Empty{}, Idle{}}, NoAction{}} : Reply}

law adopt_empty_uncertain_inert:
  {step(State{Uncertain{}, Idle{}}, AdoptEmpty{}) ==
   Reply{State{Uncertain{}, Idle{}}, NoAction{}} : Reply}

law adopt_unknown_fails:
  for +r: Residency
  for ok: {adoptable(r) == True{} : Bool}
  {step(State{r, Idle{}}, AdoptUnknown{}) ==
   Reply{State{Unknown{}, Idle{}}, NoAction{}} : Reply}

law adopt_unknown_uncertain_inert:
  {step(State{Uncertain{}, Idle{}}, AdoptUnknown{}) ==
   Reply{State{Uncertain{}, Idle{}}, NoAction{}} : Reply}

# L12: sticky StartLux is never idle-released.
law sticky_keeps:
  for +e: Nat
  for +t: Nat
  for due: {Nat.is_ge(e, t) == True{} : Bool}
  {step(State{Loaded{StartLux{}}, Idle{}}, IdleTick{e, t, False{}}) ==
   Reply{State{Loaded{StartLux{}}, Idle{}}, Keep{}} : Reply}

# L13: a non-sticky resident past the host's due point is idle-released.
law idle_unloads:
  for +m: Model
  for +e: Nat
  for +t: Nat
  for due: {Nat.is_ge(e, t) == True{} : Bool}
  for chat: {model_sticky(m) == False{} : Bool}
  {step(State{Loaded{m}, Idle{}}, IdleTick{e, t, False{}}) ==
   Reply{State{Loaded{m}, Idle{}}, Unload{m}} : Reply}

# L14: before the due point any resident is kept.
law idle_early_keeps:
  for +r: Residency
  for +e: Nat
  for +t: Nat
  for early: {Nat.is_lt(e, t) == True{} : Bool}
  {step(State{r, Idle{}}, IdleTick{e, t, False{}}) ==
   Reply{State{r, Idle{}}, Keep{}} : Reply}

# L15: an idle tick while an ordinary request is active never releases.
law idle_active_keeps:
  for +r: Residency
  for +e: Nat
  for +t: Nat
  {step(State{r, Idle{}}, IdleTick{e, t, True{}}) ==
   Reply{State{r, Idle{}}, Keep{}} : Reply}

# L16/L17: nothing resident / identity unknown is never released on idle.
law idle_empty_keeps:
  for +e: Nat
  for +t: Nat
  {step(State{Empty{}, Idle{}}, IdleTick{e, t, False{}}) ==
   Reply{State{Empty{}, Idle{}}, Keep{}} : Reply}

law idle_unknown_keeps:
  for +e: Nat
  for +t: Nat
  {step(State{Unknown{}, Idle{}}, IdleTick{e, t, False{}}) ==
   Reply{State{Unknown{}, Idle{}}, Keep{}} : Reply}

# L17b: uncertain state is never idle-released either.
law idle_uncertain_keeps:
  for +e: Nat
  for +t: Nat
  {step(State{Uncertain{}, Idle{}}, IdleTick{e, t, False{}}) ==
   Reply{State{Uncertain{}, Idle{}}, Keep{}} : Reply}

# L18: idle release completion clears the resident.
law release_done_clears:
  for +m: Model
  {step(State{Loaded{m}, Idle{}}, ReleaseDone{}) ==
   Reply{State{Empty{}, Idle{}}, NoAction{}} : Reply}

law release_done_uncertain_inert:
  {step(State{Uncertain{}, Idle{}}, ReleaseDone{}) ==
   Reply{State{Uncertain{}, Idle{}}, NoAction{}} : Reply}

law release_unknown_fails:
  for +m: Model
  {step(State{Loaded{m}, Idle{}}, ReleaseUnknown{}) ==
   Reply{State{Uncertain{}, Idle{}}, NoAction{}} : Reply}

law release_unknown_uncertain_inert:
  {step(State{Uncertain{}, Idle{}}, ReleaseUnknown{}) ==
   Reply{State{Uncertain{}, Idle{}}, NoAction{}} : Reply}

# L18c: an authorized stop that the host refuses to issue before any effect
# restores the proven resident; no uncertainty was created.
law abort_restores:
  for +m: Model
  for +x: Model
  {step(State{Loaded{x}, Stopping{m, x}}, Abort{}) ==
   Reply{State{Loaded{x}, Idle{}}, NoAction{}} : Reply}

law abort_inert_idle:
  for +r: Residency
  {step(State{r, Idle{}}, Abort{}) ==
   Reply{State{r, Idle{}}, NoAction{}} : Reply}

law abort_inert_starting:
  for +m: Model
  {step(State{Empty{}, Starting{m}}, Abort{}) ==
   Reply{State{Empty{}, Starting{m}}, NoAction{}} : Reply}

# L18b: only a host-proven clean recovery clears Uncertain, and it clears to a
# proven-empty state. The host obligation is a supervised clean state, not a
# mere probe.
law recover_clears:
  for +r: Residency
  {step(State{r, Idle{}}, Recover{}) ==
   Reply{State{Empty{}, Idle{}}, NoAction{}} : Reply}

# L19/L20: a transition in progress accepts no second transition.
law admit_inert_stopping:
  for +m: Model
  for +r: Model
  for +t: Model
  for +q: Bool
  for +a: Bool
  {step(State{Loaded{r}, Stopping{m, r}}, Admit{t, q, a}) ==
   Reply{State{Loaded{r}, Stopping{m, r}}, NoAction{}} : Reply}

law admit_inert_starting:
  for +m: Model
  for +t: Model
  for +q: Bool
  for +a: Bool
  {step(State{Empty{}, Starting{m}}, Admit{t, q, a}) ==
   Reply{State{Empty{}, Starting{m}}, NoAction{}} : Reply}

# L21/L22: stale completion events in the wrong phase are inert.
law stop_done_inert_idle:
  for +r: Residency
  {step(State{r, Idle{}}, StopDone{}) ==
   Reply{State{r, Idle{}}, NoAction{}} : Reply}

law start_ready_inert_stopping:
  for +m: Model
  for +r: Model
  {step(State{Loaded{r}, Stopping{m, r}}, StartReady{}) ==
   Reply{State{Loaded{r}, Stopping{m, r}}, NoAction{}} : Reply}

law stop_done_uncertain_inert:
  {step(State{Uncertain{}, Idle{}}, StopDone{}) ==
   Reply{State{Uncertain{}, Idle{}}, NoAction{}} : Reply}

law start_ready_uncertain_inert:
  {step(State{Uncertain{}, Idle{}}, StartReady{}) ==
   Reply{State{Uncertain{}, Idle{}}, NoAction{}} : Reply}

# L23: the policy starts fail-closed; residency is unknown until the host proves it.
law begin_unknown:
  {begin() == State{Unknown{}, Idle{}} : State}
