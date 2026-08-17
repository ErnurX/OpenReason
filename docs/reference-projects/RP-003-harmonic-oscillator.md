# RP-003 — Harmonic Oscillator Research Cycle

## Purpose

Exercise theoretical-physics contexts, conventions, symbolic derivation,
dimensional analysis, analytic and numerical comparison, conservation checks,
figure provenance, and reproducible publication artifacts.

## User brief

> Starting from the one-dimensional harmonic-oscillator Lagrangian, derive the
> equation of motion and analytic solution for displacement initial data. Check
> dimensions, reproduce the solution numerically, test energy conservation, and
> produce a comparison figure whose full provenance is retained.

## Approved context

```yaml
units: SI
time_domain: t >= 0
coordinate: q(t), dimension meter
mass: m > 0, dimension kilogram
spring_constant: k > 0, dimension newton / meter
lagrangian: L = (m/2) * q_dot^2 - (k/2) * q^2
initial_conditions:
  q(0): A
  q_dot(0): 0
reference_parameters:
  m: 2 kilogram
  k: 8 newton / meter
  A: 0.1 meter
```

For the reference parameters, `omega = sqrt(k/m) = 2 rad/s` and the period is
`pi` seconds.

## Required workstreams

### WS-003-A — Symbolic derivation

- derive the Euler-Lagrange equation from the stated Lagrangian;
- derive the displacement-initial-data solution;
- derive the conserved energy;
- attach symbolic tool traces where a CAS is used.

### WS-003-B — Physical review

- verify dimensions of every term in the equation of motion and energy;
- verify signs and the stability implied by `m > 0`, `k > 0`;
- check initial conditions and the `k -> 0` limiting behavior;
- inspect conservation of energy analytically.

### WS-003-C — Numerical reproduction

- integrate the first-order system for at least ten periods;
- use a pinned solver and tolerances;
- compare numerical and analytic displacement;
- quantify energy drift and solution error;
- save raw samples, metrics, logs, and environment.

### WS-003-D — Synthesis and figure

- produce a figure overlaying analytic and numerical displacement;
- optionally include relative energy error;
- connect the figure to code, parameters, dataset, run, and accepted claims;
- create a working-paper section with conventions and validation results.

## Expected accepted claims

### RP-003-C01 — Equation of motion

```text
m q_ddot + k q = 0.
```

### RP-003-C02 — Angular frequency and solution

```text
omega = sqrt(k / m),
q(t) = A cos(omega t)
```

for the approved displacement initial conditions.

### RP-003-C03 — Conserved energy

```text
E = (m/2) q_dot^2 + (k/2) q^2
```

is constant along exact solutions.

## Numerical thresholds

For the reference parameters and a documented high-accuracy solver run:

- maximum absolute displacement difference over ten periods: `<= 1e-6 m`;
- maximum relative energy drift: `<= 1e-6`;
- all thresholds, solver methods, tolerances, sampling, and hardware/software
  versions must appear in the run record.

The system may produce more accurate results. It may not silently loosen these
thresholds after observing a failed run.

## Deliberate traps

- Replacing the minus sign in the potential term by a plus sign changes the
  dynamics and must not pass sign/stability review.
- Dimensional consistency alone does not verify the sign or the solution.
- A visually close plot does not replace quantitative error metrics.
- A numerical trajectory does not prove exact energy conservation.
- The radian is dimensionless, but angular-frequency notation and units must be
  communicated consistently.

## Required artifacts

- approved context and conventions;
- symbolic derivation;
- dimensional and limiting-case report;
- numerical source code;
- pinned environment;
- raw trajectory dataset;
- metrics artifact;
- comparison figure;
- analytic review and numerical review;
- working-paper section;
- provenance manifest.

## Acceptance assertions

- **RP-003-A01:** The accepted equation of motion has the correct restoring sign
  and is linked to the approved Lagrangian version.
- **RP-003-A02:** Dimension checks pass for the equation of motion, frequency,
  solution, and energy under the approved SI context.
- **RP-003-A03:** The analytic solution satisfies both the equation and initial
  conditions symbolically.
- **RP-003-A04:** A pinned numerical run covers at least ten periods and meets
  both declared numerical thresholds.
- **RP-003-A05:** The figure traces to the exact dataset, run, code, environment,
  parameters, and accepted claims.
- **RP-003-A06:** A deliberately injected potential-sign error is rejected by a
  non-LLM-only verification path or explicit human gate.
- **RP-003-A07:** The exported package reproduces the numerical metrics and
  figure on a clean environment.

