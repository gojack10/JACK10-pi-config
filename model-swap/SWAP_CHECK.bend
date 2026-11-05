# One compact CPU-only offline check. Golden vectors exercise the actual
# checked core and wire codec, not a second implementation. Positive vectors
# cover reuse/sticky residency, stop-then-start swaps across every family,
# fail-closed refusal, active-request waiting and idle release; negative
# vectors cover malformed/foreign wire input and inert events.
import Base
import ./SWAP_CLI.bend as Wire
import ./SWAP_LAWS.bend as L

def compare(result: Maybe<&2, L.Reply>, expected: String) -> Bool:
  match result:
    case Some{reply}: String.eq(Wire.show_reply(reply), expected)
    case None{}: False{}

def rejected(result: Maybe<&2, L.Reply>) -> Bool:
  match result:
    case None{}: True{}
    case Some{reply}: False{}

def positive() -> Bool:
  compare(Wire.run(["0/0/0/0/0", "0/6/1/0"]), "OK 0/0/2/6/0 4/6") &&
  compare(Wire.run(["0/0/2/6/0", "3"]), "OK 1/6/0/0/0 0") &&
  compare(Wire.run(["1/6/0/0/0", "0/6/1/0"]), "OK 1/6/0/0/0 2") &&
  compare(Wire.run(["1/6/0/0/0", "0/7/1/0"]), "OK 1/6/1/7/6 3/6") &&
  compare(Wire.run(["1/6/1/7/6", "1"]), "OK 0/0/2/7/0 4/7") &&
  compare(Wire.run(["0/0/2/7/0", "3"]), "OK 1/7/0/0/0 0") &&
  compare(Wire.run(["1/7/0/0/0", "0/7/1/0"]), "OK 1/7/0/0/0 2") &&
  compare(Wire.run(["1/7/0/0/0", "0/6/1/0"]), "OK 1/7/1/6/7 3/7") &&
  compare(Wire.run(["1/6/0/0/0", "10/1800000/1800000/0"]), "OK 1/6/0/0/0 6/6") &&
  compare(Wire.run(["1/7/0/0/0", "10/1800000/1800000/0"]), "OK 1/7/0/0/0 6/7") &&
  compare(Wire.run(["begin"]), "OK 2/0/0/0/0 0") &&
  compare(Wire.run(["2/0/0/0/0", "5/1"]), "OK 1/1/0/0/0 0") &&
  compare(Wire.run(["1/1/0/0/0", "0/1/1/0"]), "OK 1/1/0/0/0 2") &&
  compare(Wire.run(["1/0/0/0/0", "0/0/1/0"]), "OK 1/0/0/0/0 2") &&
  compare(Wire.run(["1/1/0/0/0", "0/0/1/0"]), "OK 1/1/1/0/1 3/1") &&
  compare(Wire.run(["1/1/1/0/1", "1"]), "OK 0/0/2/0/0 4/0") &&
  compare(Wire.run(["0/0/2/0/0", "3"]), "OK 1/0/0/0/0 0") &&
  compare(Wire.run(["1/0/0/0/0", "0/5/1/0"]), "OK 1/0/1/5/0 3/0") &&
  compare(Wire.run(["1/0/1/5/0", "1"]), "OK 0/0/2/5/0 4/5") &&
  compare(Wire.run(["0/0/2/5/0", "3"]), "OK 1/5/0/0/0 0") &&
  compare(Wire.run(["1/5/0/0/0", "0/5/1/0"]), "OK 1/5/0/0/0 2") &&
  compare(Wire.run(["1/5/0/0/0", "0/1/1/0"]), "OK 1/5/1/1/5 3/5") &&
  compare(Wire.run(["1/5/1/1/5", "1"]), "OK 0/0/2/1/0 4/1") &&
  compare(Wire.run(["0/0/2/1/0", "3"]), "OK 1/1/0/0/0 0") &&
  compare(Wire.run(["1/1/0/0/0", "0/1/1/0"]), "OK 1/1/0/0/0 2") &&
  compare(Wire.run(["1/1/0/0/0", "0/5/1/0"]), "OK 1/1/1/5/1 3/1") &&
  compare(Wire.run(["1/0/0/0/0", "0/3/1/0"]), "OK 1/0/1/3/0 3/0") &&
  compare(Wire.run(["1/3/0/0/0", "0/4/1/0"]), "OK 1/3/1/4/3 3/3") &&
  compare(Wire.run(["1/1/0/0/0", "0/2/1/0"]), "OK 1/1/1/2/1 3/1") &&
  compare(Wire.run(["1/4/0/0/0", "0/5/1/0"]), "OK 1/4/1/5/4 3/4") &&
  compare(Wire.run(["1/5/0/0/0", "0/4/1/0"]), "OK 1/5/1/4/5 3/5") &&
  compare(Wire.run(["0/0/0/0/0", "0/5/1/0"]), "OK 0/0/2/5/0 4/5") &&
  compare(Wire.run(["1/0/0/0/0", "0/5/0/0"]), "OK 1/0/0/0/0 7") &&
  compare(Wire.run(["0/0/0/0/0", "0/5/0/0"]), "OK 0/0/0/0/0 7") &&
  compare(Wire.run(["2/0/0/0/0", "0/0/1/0"]), "OK 2/0/0/0/0 7") &&
  compare(Wire.run(["1/1/0/0/0", "0/0/1/1"]), "OK 1/1/0/0/0 1") &&
  compare(Wire.run(["2/0/0/0/0", "0/5/0/1"]), "OK 2/0/0/0/0 1") &&
  compare(Wire.run(["1/1/1/0/1", "2"]), "OK 3/0/0/0/0 7") &&
  compare(Wire.run(["0/0/2/0/0", "4"]), "OK 3/0/0/0/0 7") &&
  compare(Wire.run(["3/0/0/0/0", "5/1"]), "OK 3/0/0/0/0 0") &&
  compare(Wire.run(["3/0/0/0/0", "0/0/1/0"]), "OK 3/0/0/0/0 7") &&
  compare(Wire.run(["3/0/0/0/0", "0/5/0/0"]), "OK 3/0/0/0/0 7") &&
  compare(Wire.run(["3/0/0/0/0", "0/5/1/1"]), "OK 3/0/0/0/0 1") &&
  compare(Wire.run(["3/0/0/0/0", "10/1800000/1800000/0"]), "OK 3/0/0/0/0 5") &&
  compare(Wire.run(["3/0/0/0/0", "1"]), "OK 3/0/0/0/0 0") &&
  compare(Wire.run(["3/0/0/0/0", "3"]), "OK 3/0/0/0/0 0") &&
  compare(Wire.run(["3/0/0/0/0", "6"]), "OK 3/0/0/0/0 0") &&
  compare(Wire.run(["3/0/0/0/0", "7"]), "OK 3/0/0/0/0 0") &&
  compare(Wire.run(["3/0/0/0/0", "8"]), "OK 3/0/0/0/0 0") &&
  compare(Wire.run(["3/0/0/0/0", "9"]), "OK 3/0/0/0/0 0") &&
  compare(Wire.run(["3/0/0/0/0", "11"]), "OK 0/0/0/0/0 0") &&
  compare(Wire.run(["1/1/1/0/1", "12"]), "OK 1/1/0/0/0 0") &&
  compare(Wire.run(["3/0/0/0/0", "12"]), "OK 3/0/0/0/0 0") &&
  compare(Wire.run(["0/0/2/0/0", "12"]), "OK 0/0/2/0/0 0") &&
  compare(Wire.run(["1/0/0/0/0", "11"]), "OK 0/0/0/0/0 0") &&
  compare(Wire.run(["0/0/0/0/0", "11"]), "OK 0/0/0/0/0 0") &&
  compare(Wire.run(["2/0/0/0/0", "11"]), "OK 0/0/0/0/0 0") &&
  compare(Wire.run(["1/1/1/0/1", "0/0/1/0"]), "OK 1/1/1/0/1 0") &&
  compare(Wire.run(["0/0/2/0/0", "0/5/1/0"]), "OK 0/0/2/0/0 0") &&
  compare(Wire.run(["1/0/0/0/0", "1"]), "OK 1/0/0/0/0 0") &&
  compare(Wire.run(["1/1/1/0/1", "3"]), "OK 1/1/1/0/1 0") &&
  compare(Wire.run(["1/5/0/0/0", "10/1800000/1800000/0"]), "OK 1/5/0/0/0 5") &&
  compare(Wire.run(["1/5/0/0/0", "10/1799999/1800000/0"]), "OK 1/5/0/0/0 5") &&
  compare(Wire.run(["1/0/0/0/0", "10/1800000/1800000/0"]), "OK 1/0/0/0/0 6/0") &&
  compare(Wire.run(["1/1/0/0/0", "10/1799999/1800000/0"]), "OK 1/1/0/0/0 5") &&
  compare(Wire.run(["1/2/0/0/0", "10/1800000/1800000/0"]), "OK 1/2/0/0/0 6/2") &&
  compare(Wire.run(["1/3/0/0/0", "10/1800000/1800000/0"]), "OK 1/3/0/0/0 6/3") &&
  compare(Wire.run(["1/4/0/0/0", "10/1800000/1800000/0"]), "OK 1/4/0/0/0 6/4") &&
  compare(Wire.run(["1/0/0/0/0", "10/999999/1800000/1"]), "OK 1/0/0/0/0 5") &&
  compare(Wire.run(["0/0/0/0/0", "10/999999/1800000/0"]), "OK 0/0/0/0/0 5") &&
  compare(Wire.run(["2/0/0/0/0", "10/999999/1800000/0"]), "OK 2/0/0/0/0 5") &&
  compare(Wire.run(["1/0/0/0/0", "8"]), "OK 0/0/0/0/0 0") &&
  compare(Wire.run(["1/1/0/0/0", "9"]), "OK 3/0/0/0/0 0") &&
  compare(Wire.run(["1/0/0/0/0", "6"]), "OK 0/0/0/0/0 0") &&
  compare(Wire.run(["0/0/0/0/0", "7"]), "OK 2/0/0/0/0 0") &&
  compare(Wire.run(["1/1/0/0/0", "5/1"]), "OK 1/1/0/0/0 0") &&
  compare(Wire.run(["1/1/0/0/0", "5/0"]), "OK 1/0/0/0/0 0")

def negative() -> Bool:
  rejected(Wire.run(["1/10/0/0/0", "5/1"])) &&
  rejected(Wire.run(["1/1/0/0/0", "0/10/1/0"])) &&
  rejected(Wire.run(["1/1/0/0/0", "5/10"])) &&
  rejected(Wire.run(["1/9/0/0/0", "5/1"])) &&
  rejected(Wire.run(["4/0/0/0/0", "5/1"])) &&
  rejected(Wire.run(["1/1/0/0/0", "13"])) &&
  rejected(Wire.run(["1/1/0/0/0/0", "5/1"])) &&
  rejected(Wire.run(["1/1/0/0/0", "11/1"])) &&
  rejected(Wire.run(["1/1/0/0/0", "0/1/1"])) &&
  rejected(Wire.run(["1/1/0/0/0", "0/1/2/0"])) &&
  rejected(Wire.run(["1/1/0/0/0", "0/9/1/0"])) &&
  rejected(Wire.run(["1/1/0/0/0", "5/9"])) &&
  rejected(Wire.run(["1/0/9/0/0", "3"])) &&
  rejected(Wire.run(["1/1/0/9/0", "3"])) &&
  rejected(Wire.run(["1/0/1/0/9", "3"])) &&
  rejected(Wire.run(["x"])) &&
  rejected(Wire.run(["begin", "x"])) &&
  rejected(Wire.run([]))

def finish(ok: Bool) -> IO(Unit):
  match ok:
    case True{}:
      IO.print("offline checks passed: 95 cases")
    case False{}:
      IO.die(Unit, 1, "swap-policy check failed")

def main() -> IO(Unit):
  finish(positive() && negative())
