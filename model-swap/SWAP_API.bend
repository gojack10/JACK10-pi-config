# Sole host-facing pure entry. Importing SWAP_PROOF closes every law.
# The host constructs values and executes physical effects; it never keeps a
# second transition function.
import Base
import ./SWAP_LAWS.bend as L
import ./SWAP_PROOF.bend as Proof

def begin() -> L.State:
  L.begin()

def step(state: L.State, event: L.HostEvent) -> L.Reply:
  L.step(state, event)
