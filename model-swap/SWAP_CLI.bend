# One-shot process bridge, not a proxy or persistent driver. Every decision
# calls SWAP_API.step. The returned state is an opaque continuation token.
# Decimal/slash framing avoids a foreign JSON dependency.
#
# State:  Rtag/Rmodel/Ptag/Ptarget/President
#   residency 0=Empty 1=Loaded(model 0..7) 2=Unknown 3=Uncertain
#   phase     0=Idle 1=Stopping(target,resident) 2=Starting(target)
# Events: 0/target/qualified/active Admit; 1 StopDone; 2 StopUnknown;
#         3 StartReady; 4 StartUnknown; 5/model Adopt; 6 AdoptEmpty;
#         7 AdoptUnknown; 8 ReleaseDone; 9 ReleaseUnknown; 11 Recover;
#         12 Abort; 10/elapsed/timeout/active IdleTick
# Actions: 0 NoAction 1 Wait 2 Reuse 3/model Stop 4/model Start 5 Keep
#          6/model Unload 7 Refuse
import Base
import ./SWAP_LAWS.bend as L
import ./SWAP_API.bend as API

def numbers(xs: List<&2, String>) -> Maybe<&2, List<&2, Nat>>:
  match xs:
    case Nil{}: Some{Nil{}}
    case Con{x, tail}:
      do Maybe<&2, List<&2, Nat>>:
        n : Nat <- Nat.read(x)
        rest : List<&2, Nat> <- numbers(tail)
        return Con{n, rest}

def model(n: Nat) -> Maybe<&2, L.Model>:
  match n:
    case 0n: Some{L.Ds4Qwen{}}
    case 1n: Some{L.Ds4V41{}}
    case 2n: Some{L.Ds4Glm{}}
    case 3n: Some{L.MlxQwen{}}
    case 4n: Some{L.MlxGemma{}}
    case 5n: Some{L.StartLux{}}
    case 6n: Some{L.MlxQwen4B8Bit{}}
    case 7n: Some{L.MlxQwen4BBF16{}}
    case 8n: Some{L.MlxQwen4BAbl{}}
    case 9n: Some{L.MlxWriterBF16{}}
    case n: None{}

def boolean(n: Nat) -> Maybe<&2, Bool>:
  match n:
    case 0n: Some{False{}}
    case 1n: Some{True{}}
    case n: None{}

def residency(xs: List<&2, Nat>) -> Maybe<&2, L.Residency>:
  match xs:
    case [0n, 0n]: Some{L.Empty{}}
    case [1n, m]:
      do Maybe<&2, L.Residency>:
        x : L.Model <- model(m)
        return L.Loaded{x}
    case [2n, 0n]: Some{L.Unknown{}}
    case [3n, 0n]: Some{L.Uncertain{}}
    case xs: None{}

def phase(xs: List<&2, Nat>) -> Maybe<&2, L.Phase>:
  match xs:
    case [0n, 0n, 0n]: Some{L.Idle{}}
    case [1n, t, r]:
      do Maybe<&2, L.Phase>:
        a : L.Model <- model(t)
        b : L.Model <- model(r)
        return L.Stopping{a, b}
    case [2n, t, 0n]:
      do Maybe<&2, L.Phase>:
        a : L.Model <- model(t)
        return L.Starting{a}
    case xs: None{}

def state(xs: List<&2, Nat>) -> Maybe<&2, L.State>:
  match xs:
    case [rt, rm, pt, tt, rr]:
      do Maybe<&2, L.State>:
        r : L.Residency <- residency([rt, rm])
        p : L.Phase <- phase([pt, tt, rr])
        return L.State{r, p}
    case xs: None{}

def event(xs: List<&2, Nat>) -> Maybe<&2, L.HostEvent>:
  match xs:
    case [0n, t, q, a]:
      do Maybe<&2, L.HostEvent>:
        m : L.Model <- model(t)
        qb : Bool <- boolean(q)
        ab : Bool <- boolean(a)
        return L.Admit{m, qb, ab}
    case [1n]: Some{L.StopDone{}}
    case [2n]: Some{L.StopUnknown{}}
    case [3n]: Some{L.StartReady{}}
    case [4n]: Some{L.StartUnknown{}}
    case [5n, m]:
      do Maybe<&2, L.HostEvent>:
        x : L.Model <- model(m)
        return L.Adopt{x}
    case [6n]: Some{L.AdoptEmpty{}}
    case [7n]: Some{L.AdoptUnknown{}}
    case [8n]: Some{L.ReleaseDone{}}
    case [9n]: Some{L.ReleaseUnknown{}}
    case [11n]: Some{L.Recover{}}
    case [12n]: Some{L.Abort{}}
    case [10n, e, t, a]:
      do Maybe<&2, L.HostEvent>:
        ab : Bool <- boolean(a)
        return L.IdleTick{e, t, ab}
    case xs: None{}

def show_model(m: L.Model) -> String:
  match m:
    case L.Ds4Qwen{}: "0"
    case L.Ds4V41{}: "1"
    case L.Ds4Glm{}: "2"
    case L.MlxQwen{}: "3"
    case L.MlxGemma{}: "4"
    case L.StartLux{}: "5"
    case L.MlxQwen4B8Bit{}: "6"
    case L.MlxQwen4BBF16{}: "7"
    case L.MlxQwen4BAbl{}: "8"
    case L.MlxWriterBF16{}: "9"

def show_residency(r: L.Residency) -> String:
  match r:
    case L.Empty{}: "0/0"
    case L.Loaded{m}: "1/" ++ show_model(m)
    case L.Unknown{}: "2/0"
    case L.Uncertain{}: "3/0"

def show_phase(p: L.Phase) -> String:
  match p:
    case L.Idle{}: "0/0/0"
    case L.Stopping{t, r}: "1/" ++ show_model(t) ++ "/" ++ show_model(r)
    case L.Starting{t}: "2/" ++ show_model(t) ++ "/0"

def show_state(s: L.State) -> String:
  match s:
    case L.State{r, p}: show_residency(r) ++ "/" ++ show_phase(p)

def show_action(a: L.Action) -> String:
  match a:
    case L.NoAction{}: "0"
    case L.Wait{}: "1"
    case L.Reuse{}: "2"
    case L.Stop{m}: "3/" ++ show_model(m)
    case L.Start{m}: "4/" ++ show_model(m)
    case L.Keep{}: "5"
    case L.Unload{m}: "6/" ++ show_model(m)
    case L.Refuse{}: "7"

def show_reply(reply: L.Reply) -> String:
  match reply:
    case L.Reply{s, a}: "OK " ++ show_state(s) ++ " " ++ show_action(a)

def run(args: List<String>) -> Maybe<&2, L.Reply>:
  match args:
    case ["begin"]:
      do Maybe<&2, L.Reply>:
        return L.Reply{API.begin(), L.NoAction{}}
    case [s, e]:
      do Maybe<&2, L.Reply>:
        sf : List<&2, Nat> <- numbers(String.split(s, '/'))
        ef : List<&2, Nat> <- numbers(String.split(e, '/'))
        st : L.State <- state(sf)
        ev : L.HostEvent <- event(ef)
        return API.step(st, ev)
    case args: None{}

def output(reply: Maybe<&2, L.Reply>) -> IO(Unit):
  match reply:
    case Some{r}: IO.print(show_reply(r))
    case None{}: IO.die(Unit, 2, "invalid swap-policy input")

def handle(args: List<String>) -> IO(Unit):
  output(run(args))

def main() -> IO(Unit):
  do IO<Unit>:
    args : List<String> <- IO.args()
    handle(args)
