# A local, reversible curve through traced clicks

Research note for the track tool, part of map [#287](https://github.com/rails49/occupancy/issues/287).
The rule it led to is [#317](https://github.com/rails49/occupancy/issues/317).
Written 2026-11-03. It builds on [`track-arcs-in-image.md`](track-arcs-in-image.md) (how much a
layout circle bends in the photo) and [`track-fitting-methods.md`](track-fitting-methods.md)
(least-squares fits of straights and arcs), and does not repeat them.

Question: the person clicks points along the middle of a track. Click 1 is the start, click 2 sets
the direction, and the first piece is straight. Each later click adds one circular arc from the
previous click, tangent there to the piece before. Two complaints: an edit far back changes
everything after it, and the clicks in reverse order give another line. Are the stated reasons
right, and is there a rule that is local and gives the same line in either order?

Tags: [REPO] read from this repository, [SRC] cited from the source named, [DER] derived here,
[SIM] computed by the script in § Method, [INF] my inference.

## Answer

1. Both claims are right (§ The two claims). The one arc through two clicks with a given start
   heading ends at the start heading mirrored in the chord. The heading at click n is then an
   alternating sum of every chord angle before it, so a change anywhere keeps its size to the end
   of the line, flipping side at every click. Gössner states the same recurrence for arc splines
   (2025, Theorem 5). [DER] [SRC]
2. It is worse than the claim says. Click noise adds up: the heading error at the last click grows
   as 4σ√(n−2)/h for n clicks h apart with noise σ. At σ = 0.075 G and h = 5 G that is 10° after
   10 clicks and 21° after 40. [DER] [SIM]
3. No rule with one arc per gap can be local. Every arc in such a line is fixed by the first arc's
   angle and the chord angles (Gössner, Theorem 5). Choosing that angle by a symmetric global
   criterion makes the line reversible but still not local. A local G1 line of circular arcs
   through the clicks needs two arcs per gap: a biarc. [SRC] [DER]
4. Recommended: estimate a heading at each click from its neighbours only, then join each pair of
   clicks with the equal-chord biarc. Any edit then changes at most three gaps on each side of
   the click. The line is the same in either order, straights and single circles come out exact,
   and noise stays at the level of the clicks (mean worst deviation 0.16–0.17 G at σ = 0.075 G,
   against 0.31–0.41 G for one arc per click). [DER] [SIM]
5. The heading estimate decides whether a straight can leave a curve. The tangent of the circle
   through a click and its two neighbours, the obvious choice, is off at a join: 0.07 G at
   h = 5 G, R = 15 G and 0.28 G at h = 10 G. A weighted choice between the circle that ends at
   the click and the circle that starts there, after Akima (1970), is exact when the join is at a
   click with two clicks on each side. That rule is § Recommendation. [SRC] [SIM]
6. Build the curve in image pixels. Each gap is short, so a layout circle seen as an ellipse is
   followed to within 0.01–0.06 G even at an axis ratio of 0.8. A rectified ground plane needs a
   homography the calibration does not have, and its arcs would be ellipse arcs in the image,
   which the stored nodes draw less well. [SIM] [REPO]

## After the prototype

Decided with the user on 2026-11-03, after trying `ui/prototypes/track-trace/` (branch
`track-trace-prototype`, commit 983e3dc; open `index.html`, no server).

Requirements the user set:

- The line passes through every free click. Clicks are good to about 0.1 G, and the tool does
  not average them away. A run fitted as one piece may miss a click by up to 0.1 G, no more.
- A straight is exactly straight. Aiming the end of an arc along the straight is too fiddly:
  moving the last arc click sideways by δ turns the end heading by 2δ/h, so at h = 5 G a 0.1 G
  move swings the projection 0.8 G at 20 G ahead, and the point where the arc ends cannot be seen
  in the photo (it leaves a 30 G arc by only 0.1 G over 2.5 G). [DER]
- Dragging a click, inserting one anywhere, and adding one at either end change the line only near
  the edit.

What the prototype builds:

- Each gap is marked free, straight or one radius. Neighbouring gaps with the same mark form a run.
- A free click is on the line and takes its heading by rule 2 of § Recommendation. Each free gap
  is the equal-chord biarc.
- A straight run is the total least squares line through its clicks. A one-radius run is the
  least-squares circle through at least three clicks. A click shared by a straight and a
  one-radius run belongs to the straight, and the circle is fitted to touch that straight, or both
  straights when it has one on each side. A run click more than the tolerance (0.1 G) off its
  piece is flagged.
- Free clicks meeting a run: the circle through the last two free clicks that touches the run
  sets their headings and where the run starts. It is kept only if its radius is at least 15 G
  and it touches the run between the last free click and the run's second click; otherwise the
  last free gap is a biarc to the run's first click.
- The tool does not guess which clicks are straight. At 0.1 G, a 50 G curve and a straight are
  indistinguishable over about 9 G of track (the best line is L²/16R off an arc of length L).

What it showed, on synthetic track at 1 G = 12 px [SIM, in the prototype's walkthroughs]:

- Moving click 6 of 16 sideways by 0.5 G: the old rule changes the line from click 5 to the end;
  the new rule between clicks 4 and 8.
- Reversing the click order gives the same line in every case. The old rule's reversed line is
  up to 0.38 G away.
- Straight, 30 G quarter circle, straight, a click every 5 G, noise 0.04 G: with the straights
  marked straight and the curve one radius, the straights are exact, the radius is 30.0 G, and
  the curve touches both straights at the shared clicks.
- An 80 G curve clicked every 3 G, noise 0.04 G: with free gaps the radius swings from gap to gap,
  since a radius from clicks h apart is uncertain by about 2.5σ/h² in curvature. Marked one
  radius it fits 79.8 G, every click within 0.07 G.
- Inserting a click on the line moves it by less than 0.01 G. A click added at the start changes
  clicks 1 to 3 only.
- Rebuilding the line takes under 20 ms per pointer move with 80 clicks in the browser.

Heading rule: the weighted rule (rule 2) is kept over the circle through three clicks. They differ
only where the radius changes at a click inside a free stretch; at a run's end the joining circle
sets the heading. Exact clicks, every gap free, distance from the true track [SIM]:

| Click spacing | Straight into R 30 | R 30 into R 60 | S-curve, R 30 each way |
|---|---|---|---|
| 3 G | 0.003 / 0.013 G | 0.001 / 0.005 G | 0.006 / 0.019 G |
| 5 G | 0.000 / 0.035 G | 0.000 / 0.017 G | 0.000 / 0.069 G |
| 10 G | 0.000 / 0.139 G | 0.000 / 0.070 G | 0.000 / 0.277 G |

First number the weighted rule, second the three-click circle. With the change of radius halfway
between clicks both are within 0.035 G at 10 G spacing; with 0.05 G click noise on one circle both
give the same 0.08 to 0.11 G. The three-click circle changes one gap fewer on each side of an edit.

Limits found:

- A free gap with no click between two runs is joined by a biarc between the run ends, which is
  not exact. A click near the junction, shared by both runs, makes the join exact.
- Two one-radius runs that share a click are joined by a short biarc; neither circle is fitted to
  touch the other.

## What the code does now

The current rule is not the one in the question. `ui/src/trackFit.ts` (`extend`, #311) keeps a
part going while each click lies within the tolerance (0.5 G) of the part carried on, and refits
that part by least squares over its clicks. Only a click beyond the tolerance starts a new part,
and that new part is the step in the question: the one arc from the join, with the heading there,
through the click. [REPO]

So both complaints already hold for it, and SPEC says so. "The parts before the part of the edited
click are unchanged": every part after it is rebuilt. "A line last built backwards can come out
different" (SPEC § Track centerlines). `TrackChain` traces a line continued from its first click
backwards and turns the nodes round (`turned` in `ui/src/trackChain.ts`), so that line is built
by the rule run backwards. `TRACK-EDITOR.md`, beside the repository clones, asks to drop the tangent rule because "it makes it near
impossible to create straight track segments after a curve": the straight must leave at the
arc's end heading, which the last arc clicks fix. The dotted tangent drawn after an arc (SPEC
§ Track centerlines) is there to help aim it. [REPO]

## The two claims

### Claim 1: one arc per click is not local

Derived here. Write headings as angles. Let γᵢ be the angle of the chord from Pᵢ to Pᵢ₊₁ and φᵢ
the heading at Pᵢ.

- Uniqueness. A circle tangent to a heading at Pᵢ has its centre on the normal there. It passes
  through Pᵢ₊₁ only if the centre is also on the perpendicular bisector of the chord. The two
  lines meet once, or never when Pᵢ₊₁ lies on the tangent line, and then the piece is straight.
  So the piece is unique for Pᵢ₊₁ ≠ Pᵢ. When Pᵢ₊₁ lies behind the heading the arc turns more
  than 180°.
- End heading. A circular arc is symmetric about the perpendicular bisector of its chord. The
  angle from the chord to the start heading equals the angle from the end heading to the chord:
  φᵢ₊₁ − γᵢ = γᵢ − φᵢ, so φᵢ₊₁ = 2γᵢ − φᵢ. In vectors this is the claim's
  t' = 2(c·t)c − t, the start tangent mirrored in the unit chord c.
- Propagation. With φ₁ = γ₀ (the first piece is straight),
  φₙ = 2(γₙ₋₁ − γₙ₋₂ + γₙ₋₃ − …) ± γ₀. A change δ in any one γ changes every later heading by
  ±2δ, alternately to the left and the right. Nothing decays. Each later arc's sagitta changes
  by about hδ/2, to alternate sides, so the line snakes about the true track from the edit to
  the end. [SIM]: moving click 8 of 19 on a circle by 1 G turns the heading at click 8 by 6.7°
  and at each of the ten later clicks by 9.5°, alternately −9.5° and +9.5°.
- Noise. On a straight with clicks h apart and sideways noise eᵢ, γᵢ ≈ (eᵢ₊₁ − eᵢ)/h. Put into
  the alternating sum, every inner click enters φₙ with weight ±4/h, so the variance of φₙ is
  about 16(n − 2)σ²/h² and its spread is 4σ√(n−2)/h. [SIM], 2000 trials, h = 5 G,
  σ = 0.075 G: 5.9°, 9.9°, 14.2° and 21.2° after 5, 10, 20 and 40 clicks; the formula gives
  6.0°, 9.7°, 14.6° and 21.2°.

Gössner reaches the same recurrence for arc splines over a polygon. Each arc angle "depends on
start angle θ₀ and the alternating sum of preceding exterior angles of the polygonial curve", and
such arc splines form "a one parameter family of arc spline curves" set by the first arc
(Gössner 2025, Theorem 5 and § 3.2). [SRC]

### Claim 2: the reversed order gives another line

Right as stated. [DER] Reversal maps the arc from Pᵢ to Pᵢ₊₁ onto itself: run backwards, it
starts at Pᵢ₊₁ with heading φᵢ₊₁ + π and passes through Pᵢ. That is the unique arc for that
data, so a reversed line seeded with φₙ + π rebuilds every arc of the forward line. [SIM] gives
a distance of 0 between the two. The plain reversed line starts with a straight from Pₙ to
Pₙ₋₁, and the forward line generally ends on an arc there, so the two differ from that gap on.
By claim 1 the difference then keeps its size along the whole line ([SIM]: 0.16 G for 19 noisy
clicks on a circle).

The seed φₙ + π depends on every click, so seeding that way only moves the problem. A seed chosen
by a criterion that is the same in either direction, such as least length or least bending
energy over the whole line (Gössner 2025, § 3.3), makes the line reversible. It does not make it
local: one free angle cannot cancel a change on both sides of an edit. [SRC] [DER]

## Why two arcs per gap

A biarc joins two points with given headings by two circular arcs, tangent where they meet. The
data leave one degree of freedom, "thus there is a one-dimensional family of interpolating
biarcs", and "all the possible joint points must be on a certain circle", the joint circle
(Bertolazzi & Frego 2017, § 1, citing Šír, Feichtinger & Jüttler 2006). Meek & Walton (2008)
characterise the family; only the bibliographic record and a library abstract were reachable. [SRC]

With a heading fixed at every click, each gap is a biarc that depends only on its two clicks and
their two headings. If the headings come from nearby clicks, the line is local. If the heading
rule and the choice of joint are the same in both directions, it is reversible. [DER]

This is not new. Karow's Ikarus font system took headings from a cubic through the points and
put a biarc in each gap. Levien rates its roundness "fairly decent, as the biarc becomes a
circular arc when the endpoint tangents are symmetrical", and reports Karow's advice of "one
control point for every 30 degrees of arc" (Levien 2009, § 4.5). Séquin, Lee & Yen's circle
spline uses the same local heading as recommended below, the tangent of the circle through a
point and its two neighbours, but blends circles between points instead of using arcs; moving a
point "only affects four segments" (Levien 2009, § 4.10; the 2005 paper itself was not reached).
[SRC]

### The joint

Derived here, checked against the sources. Put the chord from P₀ to P₁ along the x axis, length
d, and let θ₀ and θ₁ be the end headings measured from the chord. The arc from P₀ to the joint J
has chord angle α = (θ₀ + φ_J)/2, and the arc from J to P₁ has chord angle β = (φ_J + θ₁)/2. So
β − α = (θ₁ − θ₀)/2 is fixed: J sees the chord under a fixed angle and lies on a circle through
P₀ and P₁. That is the joint circle.

- One arc. If θ₁ = −θ₀ the headings fit one arc. That arc lies on the joint circle, and for any J
  on it both arcs are the arc itself. Every joint choice reproduces a single circle. If
  θ₀ = θ₁ = 0, the joint circle is the chord and both arcs are straight. [DER]
- Equal chord. J on the perpendicular bisector of the chord, so the two chords are equal:
  J = midpoint + (d/2)·tan((θ₀ − θ₁)/4)·n, with n the chord's left normal, and joint heading
  φ_J = γ − (θ₀ + θ₁)/2. [DER] This is MATLAB's `rscvn` rule as Bertolazzi & Frego restate it:
  the joint heading is the mean of the end headings mirrored in the chord, 2α − (ϑ₀ + ϑ₁)/2 with
  α the chord angle (2017, eq. 4). Gössner calls it "a numerically robust approach that also
  works for parallel end tangents", while the parallel-tangent biarc "only works for non-parallel
  end tangents" (2025b, § 5.1–5.2). [SRC]
- Reversal. Reversed, the chord turns by π and θ₀ and θ₁ swap. The formula gives the same J and
  the same arcs. [DER] [SIM]: distance 0 between the forward and reversed lines.

Bolton (1975) and Sabin (1977) introduced biarcs; neither was reachable beyond the bibliographic
record, so which joint each used is not stated here.

## Comparison

h is the click spacing, R the radius, σ the click noise; all in gauges. A gap is the curve
between two neighbouring clicks. The noise column is the mean over 200 trials of the worst
distance from the true track, σ = 0.075 G, h = 3 and 5 G, for a straight, a 180° circle of R 30
and a straight into an arc. Values at or below 0.01 G are the measurement floor. [SIM] unless marked.

| Method | An edit reaches | Same in reverse | Straight / circle exact | Straight after a curve | Clicks | Drawing | Noise, worst |
|---|---|---|---|---|---|---|---|
| One arc per click (the question) | Every later gap, no decay | No | Yes / yes | Exact only if a click is at the join and the arc clicks are exact | 2 straight, 3 arc | `A` arcs; parts | 0.31–0.41 G, grows with n |
| Projection rule (now, #311) | The edited click's part and all later parts [REPO] | No [REPO] | Yes / yes | Aim the arc's end tangent along the straight [REPO] | 2, 3, more to average | Parts to nodes | Averaged within a part; a new part from one click [REPO] |
| One arc per click, seed by a global criterion (Gössner 2025) | Every gap | Yes, if the criterion is | Yes / yes | Not controlled | As above | `A` arcs | Not measured |
| Biarc, tangent of circle through three clicks | 2 gaps each side | Yes | Yes / yes | Off by 0.015–0.28 G at a join on a click | 2, 3 | 2 arcs per gap | 0.16–0.17 G |
| Biarc, Catmull–Rom heading | 2 gaps each side | Yes | Yes / no: 0.12 G on a circle with uneven clicks | As the row above | 2, 3 | 2 arcs per gap | 0.16–0.17 G |
| Biarc, one-sided weighted heading (recommended) | 3 gaps each side | Yes | Yes / yes | Exact with the join on a click and two clicks each side | 2, 3; 2 more around a join | 2 arcs per gap | 0.16–0.17 G |
| Catmull–Rom cubic | 2 segments each side [DER] | Yes [INF] | Yes / no | Not exact | 2, 3 | Cubics | Not measured |
| Séquin circle spline | 2 segments each side [SRC] | Yes [INF] | Yes / yes [SRC] | Not exact; not arcs | 2, 3 | Sampled | Not measured |
| Clothoid per gap (Bertolazzi & Frego 2015), same headings | As the heading rule | Yes [INF] | Yes / yes [SRC] | As the heading rule | As biarc | Sampled; Fresnel integrals | Not measured |
| Spiro, Euler spiral spline (Levien 2009) | All, falling 3.73× per click [SRC] | Yes [SRC] | Yes / yes [SRC] | The person marks it with `[` `]` (`track-fitting-methods.md`) | Few | Spirals, sampled | Keeps click noise as curvature wiggles [INF] |
| Least-squares fit, segmentation and G1 refit | Can flip the segmentation (`track-fitting-methods.md`) | Not checked | Yes / yes | Decided by a cost per part | Many, to average | Parts to nodes | Averages noise |

Notes on the table:

- All the biarc rows put every click on the line, so the line is as noisy as the clicks: the
  worst point is about 2.2σ off. One arc per click adds the snaking of claim 1. [SIM]
- A layout circle seen under tilt is an ellipse in the photo. Clicks on an ellipse of semi-axes
  30 G and 24 G, h = 3, 5, 10 G: the biarc line with circle headings stays within 0.012, 0.012
  and 0.060 G; with Catmull–Rom headings 0.026, 0.11 and 0.19 G. [SIM]
- A join halfway between two clicks is not exact under any rule. All the heading rules are then
  within 0.01–0.11 G for h up to 10 G and R 15–30 G. [SIM]
- A global scheme can still be acceptable if its influence falls fast. Spiro's falls by
  2 + √3 ≈ 3.73 per point (Levien 2009, § 2.6), so an edit moves the line 3 clicks away by 2% of
  its own move. Levien notes that "finite support conflicts directly with extensionality", the
  property that adding a point on the line leaves it unchanged. One arc per click has a factor of 1. Spiro
  is ruled out here because it gives spirals, not arcs, needs a nonlinear solve, and makes
  straights a mark the person sets. [SRC] [DER]
- Clothoids are what real railways use between a straight and a curve (Levien 2009, § 6.6). A
  clothoid per gap matching both headings exists and is unique in a stated range, and needs
  Fresnel integrals with care near straights and arcs (Bertolazzi & Frego 2015, abstract). It
  gives no locality or symmetry the biarc lacks, and the photo does not show whether a layout has
  easements. [SRC] [INF]
- Drawing. SVG draws circular and elliptical arcs natively: `A rx ry x-axis-rotation
  large-arc-flag sweep-flag x y` "draws an elliptical arc from the current point to (x, y)", and
  "if rx = 0 or ry = 0 then this arc is treated as a straight line segment" (SVG 1.1 § 8.3.8,
  § F.6.2). A straight must be written as `L`, not as a huge radius. The rails of an arc are
  concentric arcs. The app draws from nodes with `C` (`trackPath` in `ui/src/track.ts`) and the
  rails by sampling (`sampleFit`), so it needs neither. [SRC] [REPO]

## Recommendation

Interpolate every click with one equal-chord biarc per gap, with headings from neighbouring
clicks by the rule below. Clicks are P₀ … Pₙ₋₁. γᵢ is the angle of the chord from Pᵢ to Pᵢ₊₁.
Every difference of angles is wrapped to (−π, π].

1. Circle through three clicks A, B, C. Heading at the middle:
   φ_B = γ_AB + wrap(γ_BC − γ_AB) − wrap(γ_AC − γ_AB).
   Heading at A: 2γ_AB − φ_B. Heading at C: 2γ_BC − φ_B. Curvature:
   κ(A, B, C) = 2·sin(wrap(γ_BC − γ_AB)) / |AC|, positive turning left.
   Collinear clicks give the chord heading and κ = 0. [DER, the tangent-chord angle theorem]
2. Heading at click i, for 2 ≤ i ≤ n − 3: [DER, after Akima 1970]
   - t_b: heading at Pᵢ of the circle through Pᵢ₋₂, Pᵢ₋₁, Pᵢ. t_f: heading at Pᵢ of the circle
     through Pᵢ, Pᵢ₊₁, Pᵢ₊₂.
   - κ_b, κ_m, κ_f: curvatures of the circles through (Pᵢ₋₂, Pᵢ₋₁, Pᵢ), (Pᵢ₋₁, Pᵢ, Pᵢ₊₁) and
     (Pᵢ, Pᵢ₊₁, Pᵢ₊₂).
   - Weight on t_b: w_b = |κ_f − κ_m|. Weight on t_f: w_f = |κ_b − κ_m|.
   - tᵢ = t_b + w_f/(w_b + w_f) · wrap(t_f − t_b), and halfway when w_b + w_f is zero to rounding.
   Why it works: at a join on a click, the clicks on each side lie on one straight or circle, so
   t_b and t_f are both the true heading and any mix of them is exact. The circle through the
   click and its two neighbours straddles the join and is not. Along one circle, κ_b = κ_m or
   κ_m = κ_f, and the weights pick the side that agrees. Akima's rule for functions has the same
   shape: the slope at a point is a mix of the slopes on either side, each weighted by how much
   the slopes change on the other side, w₁ = |δᵢ₊₁ − δᵢ| and w₂ = |δᵢ₋₁ − δᵢ₋₂| (SciPy's
   statement of it; Akima's paper was not reachable).
3. Heading at click 1 and click n − 2: the middle heading of the circle through the click and its
   two neighbours (rule 1).
4. Ends. t₀ = 2γ₀ − t₁ and tₙ₋₁ = 2γₙ₋₂ − tₙ₋₂: the end gap is the one arc through its two
   clicks tangent at the inner click. [DER] Two clicks give a straight. Three clicks give the one
   arc through all three, as now.
5. Each gap: the equal-chord biarc of § The joint. If the two arcs have the same curvature to
   rounding, they are one part; if both headings lie along the chord, the gap is one straight.
6. A straight after a curve: click the join, and put at least two clicks on the straight after it
   and two on the curve before it. Rule 2 then gives the join its true heading from both sides,
   and the gaps on the straight are exactly straight ([SIM]: 0.0 G off the straight, against
   0.052 G with the three-click circle heading). With fewer clicks the join gets the three-click
   circle heading, off by 0.015–0.28 G depending on h and R ([SIM]). Superseded: the user marks
   the straight, which is then exact without a click on the join (§ After the prototype).

What it gives [DER] [SIM]:

- An edit changes the headings of the moved click and up to two clicks on each side, so at most
  three gaps on each side of it change. Inserting a click is the same. A new click on the end
  changes the last three gaps, not only the last.
- The line is the same for either order of the clicks. `TrackChain` would no longer need to
  trace a continued line backwards to get the same line, but it still adds the new clicks at the
  front.
- Every click is on the line. Noise is not averaged; the line stays within about 2.2σ of the
  track.
- Every part is a straight or a circular arc and every join is tangent, as SPEC requires. Each
  biarc arc covers less than one gap, so it rarely reaches the 90° at which `fitNodes` splits.

What of the code it can reuse [REPO]:

- `Fit`, `Pose` and `Part` in `ui/src/trackFit.ts`: a start pose and a length and curvature per
  part. A biarc line is a `Fit` with two parts per gap. `advance`, `poses`, `ahead`, `fitNodes`
  and `sampleFit` work unchanged. An arc from A with heading a to B has turn
  τ = 2·wrap(γ_AB − a), length |AB|·(τ/2)/sin(τ/2) and curvature τ/length.
- `through` already returns a circle's curvature and its heading at the first of three points.
- `segment` in `ui/src/track.ts` draws an arc between two nodes when the headings are symmetric
  about the chord, which each biarc arc is, so stored nodes need no format change.
- `Trace`, its undo history and `TrackChain` stay. `Trace.rebuilt` and the refusal of a radius
  under `TRACK_FIT.minRadius` can stay.
- Gone: the tolerance test, `refit`, `leastSquares`, `foot` for continuing a part, and
  `Line.firstClick`, since parts no longer belong to clicks. `tests/trackLocality.test.ts`
  would test the new reach and reversal instead.

## Image pixels or a rectified ground plane

Build the curve in image pixels.

- In the image, "a circle comes out exact" means a circle in the photo. A layout circle is an
  ellipse there under tilt (`track-arcs-in-image.md` § Answer, item 5). The local rule follows it
  anyway: each gap takes its own curvature, and the ellipse test above stays within 0.06 G at
  h = 10 G. Grade and lens distortion bend the photo curve in ways no plane removes, and the
  local rule follows those too. [SIM] [INF]
- A rectified plane needs a homography. The calibration holds DPT and camera height only and maps
  no image position to a layout position ([ADR 0015](../adr/0015-camera-height-corrects-scale.md),
  `track-arcs-in-image.md` item 6). [REPO]
- What it would change. Straights stay straight under any projective map, so straightness is the
  same in both spaces. Circles become ellipses in the image: a projective image of a circle is a
  conic. Built in the plane, a curve of one radius would be one arc and the minimum radius a real
  radius. Mapped back, each arc would be an ellipse arc, which SVG `A` draws (rx ≠ ry, rotation)
  but which `segment` draws as an arc only when the headings are symmetric about the chord, which
  an ellipse arc's are not. So the stored nodes would need more points per arc. [DER] [REPO]

## Open questions

- Click noise. Settled: free clicks stay on the line, and marked runs take up the noise within
  0.1 G (§ After the prototype). Averaging headings over five clicks is dropped.
- The projection. A biarc line has no "current part" to carry on. The prototype draws the end
  tangent, dotted, as a check, not as something to aim along. The end of the line moves when the
  next click comes, over the last three gaps.
- Whether to keep the tolerance's other job: refusing or ignoring a click behind the end of the
  line. A biarc to a click behind the line makes a loop, so some such rule is needed.
- Parts that are nearly straight or nearly one radius because of noise. Settled: the user marks
  them straight or one radius; the tool does not snap.
- Rule 2 leaves the first and last two clicks to the three-click circle. A join at click 1 or
  n − 2 is therefore not exact; clicking once more past it fixes that.
- The joint choice matters little when the two headings fit nearly one arc, which is the usual
  case on track. Gössner's cubic-midpoint joint (2025b, § 5.5) is an alternative not tested here.

## Method

Script run with `uv run --with numpy --with scipy` in the session scratchpad, not kept in the repo.
What it does, so the numbers can be recomputed:

- True track: straights and arcs from a start pose, sampled every 0.02 G. Clicks are track samples
  at the given arc lengths, plus Gaussian noise of σ = 0.075 G across both axes when stated.
- Lines: one arc per click, as in the question; and biarc lines with three heading rules (circle through
  three clicks, Catmull–Rom chord P(i+1) − P(i−1), and rule 2), the end rule 4 and the
  equal-chord joint, each arc sampled every 0.02 G or finer.
- Deviation: the larger of the farthest line point from the track and the farthest track point,
  between the first and last click, from the line. The floor from sampling is 0.01 G.
- Cases: R 15 and 30 G, h 3, 5 and 10 G; a join on a click and halfway between clicks; an arc,
  straight, reverse-arc line with R 20 G; an ellipse of semi-axes 30 and 24 G over 180°.
  Noise: 200 trials per case; heading spread at the last click: 2000 trials.

## Sources

- S. Gössner, "Symplectification of Circular Arcs and Arc Splines", Aug. 2025,
  [arXiv 2508.07726](https://arxiv.org/abs/2508.07726) (read in full). Cited as Gössner 2025.
- S. Gössner, "Symplectifying Biarcs", Nov. 2025, [arXiv 2511.00163](https://arxiv.org/abs/2511.00163)
  (read in full). Cited as Gössner 2025b.
- E. Bertolazzi, M. Frego, "A Note on Robust Biarc Computation", 2017,
  [arXiv 1711.00935](https://arxiv.org/abs/1711.00935) (read in full).
- E. Bertolazzi, M. Frego, "G1 fitting with clothoids", Math. Methods Appl. Sci. 38(5) (2015)
  881–897, [arXiv 1305.6644](https://arxiv.org/abs/1305.6644) (abstract and introduction read).
- R. Levien, "From Spiral to Spline: Optimal Techniques in Interactive Curve Design", PhD thesis,
  UC Berkeley, UCB/EECS-2009-162, [PDF](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2009/EECS-2009-162.pdf)
  (chapters 2 and 4 read).
- C. Yuksel, S. Schaefer, J. Keyser, "Parameterization and applications of Catmull-Rom curves",
  CAD 43(7) (2011) 747–755, [PDF](https://www.cemyuksel.com/research/catmullrom_param/catmullrom_cad.pdf)
  (abstract and introduction read). The original, E. Catmull, R. Rom, "A class of local
  interpolating splines", in Barnhill & Riesenfeld (eds.), Computer Aided Geometric Design,
  Academic Press 1974, 317–326, was not reached.
- H. Akima, "A new method of interpolation and smooth curve fitting based on local procedures",
  J. ACM 17(4) (1970) 589–602, doi:10.1145/321607.321609. Not reachable (ACM returned 403); the
  weights are taken from SciPy's
  [`Akima1DInterpolator`](https://docs.scipy.org/doc/scipy-1.16.1/reference/generated/scipy.interpolate.Akima1DInterpolator.html)
  notes.
- W3C, Scalable Vector Graphics (SVG) 1.1, [§ 8.3.8 Elliptical arc](https://www.w3.org/TR/SVG11/paths.html#PathDataEllipticalArcCommands)
  and [§ F.6 Elliptical arc implementation notes](https://www.w3.org/TR/SVG11/implnote.html#ArcImplementationNotes).
- Bibliographic record only, not read: K. M. Bolton, "Biarc curves", CAD 7(2) (1975) 89–92,
  doi:10.1016/0010-4485(75)90086-X; M. A. Sabin, "The use of piecewise forms for the numerical
  representation of shape", Report 60/1977, Computer and Automation Institute, Hungarian Academy
  of Sciences; D. S. Meek, D. J. Walton, "Approximation of discrete data by G1 arc splines", CAD
  24(6) (1992) 301–306; D. S. Meek, D. J. Walton, "The family of biarcs that matches planar,
  two-point G1 Hermite data", JCAM 212(1) (2008) 31–45 (a library abstract read); Z. Šír,
  R. Feichtinger, B. Jüttler, "Approximating curves and their offsets using biarcs and
  Pythagorean hodograph quintics", CAD 38(6) (2006) 608–618; C. H. Séquin, K. Lee, J. Yen, "Fair,
  G2- and C2-continuous circle splines for the interpolation of sparse data points", CAD 37(2)
  (2005) 201–211; J. Rossignac, A. Requicha, "Piecewise-circular curves for geometric modeling",
  IBM J. Res. Dev. 31(3) (1987) 296–313.
