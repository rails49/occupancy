# Fitting straights and circular arcs to clicked points

Written 2026-11-01. Research note on
[#288](https://github.com/rails49/occupancy/issues/288), part of map
[#287](https://github.com/rails49/occupancy/issues/287), for the prototype ticket
[#290](https://github.com/rails49/occupancy/issues/290). It compares methods that turn tens of
clicks along the middle of a track into a sequence of straights and circular arcs, tangent where
they meet (G1), with the number of parts chosen by the method.

*Sources: Drysdale, Rote & Sturm (EWCG 2006 version, read in full); Maier's dissertation "Smooth
Minimum Arc Paths" (read in full); Schindler, Maier & Janda, IEEE IV 2012 (read in full); Jeon,
Hwang & Choi, CAGD 2024 (arXiv 2401.09770, read in full); Kanatani's comment on Rosin & West, PAMI
1997 (read in full); Levien's PhD thesis "From Spiral to Spline", UCB/EECS-2009-162 (relevant
chapters read); `raphlinus/spiro` source (`ppedit/spiro.c`); `be5invis/spiro-js` and
`fontforge/libspiro` READMEs; npm registry metadata. For the road and rail papers (Koc 2022,
Camacho-Torregrosa et al. 2015, Castro et al. 2024, Imran et al. 2006, Lipar et al. 2011) and for
Meek & Walton, Held & Eibl, Horng & Li, Maier 2014 and Maier, Janda & Schindler 2012, only the
abstract or bibliographic record was reachable; claims about them are limited to that. Numbers
marked "derived here" are worked in this note, not taken from a source.*

---

## Answer

No published method matches the task exactly: few points (tens), click noise, G1 straights and
arcs, the count chosen automatically, and a refit on every click and drag. The pieces exist and
are each small at this size. Every method below costs well under a millisecond for 50 points; cost
does not separate them. What separates them is how they decide the number of parts and the type of
each part, and how much the result jumps when one point moves.

Ranked recommendation for #290:

1. Penalised segmentation by dynamic programming, then one joint G1 least-squares refit. Every run
   of consecutive points is fitted as a straight and as a circle. Dynamic programming picks the
   split that minimises squared error plus a fixed cost per part (and a further cost for an arc
   over a straight), rejecting any part whose worst point exceeds the tolerance. A final refit
   over all parts together, parameterised so that tangency holds by construction, removes the
   kinks the independent fits leave. Needs from the person: the tolerance (default 0.25 G) and
   either the click noise or the per-part cost (a default can be derived from G).
2. Fewest parts that meet the tolerance. Run the same joint G1 refit with 1, 2, 3, ... parts,
   splitting the worst part each time (the scheme of Jeon et al. 2024), and stop at the first count
   whose worst point is within the tolerance. Then make a part straight if the refit still meets
   the tolerance with its curvature set to zero. Needs from the person: the tolerance only.
3. Not for #290, but for the later hand-correction question: Spiro. It passes through every click
   and decides nothing itself; the person marks where straights begin and end. It is the only
   option here with a ready, permissively licensed TypeScript implementation (npm `spiro`).

Methods 1 and 2 share the refit code and differ only in how they pick the parts, so #290 can
compare them on the same photos for little extra work. Neither has a usable JavaScript or
TypeScript library; each is a few hundred lines on top of a small dense least-squares solver.

---

## The problem in numbers

These figures are derived here. They set the scale for every method below.

- Gauge and radius. G is about 10–40 px. Model curves have radius R of about 25–40 G (HO 18–24 in
  over 16.5 mm gauge is 28–37 G). Curvature is then about 0.025–0.04 per G.
- Tolerance. The hard limit t = 0.25 G is 5 px at G = 20 px.
- When an arc can pass for a straight. An arc of length L sits at most L²/(8R) from its chord. With
  R = 30 G and t = 0.25 G, any arc shorter than √(8Rt) ≈ 7.7 G fits inside the tolerance as a
  straight. So the tolerance alone cannot tell a short curved part from a straight.
- Where the straight ends. If a straight is extended a distance d past the true tangent point into
  an arc, it leaves the arc by d²/(2R). That reaches t only at d = √(2Rt) ≈ 3.9 G (R = 30 G,
  t = 0.25 G). The squared error grows only as d⁵ near the right place. The position of a
  straight-to-arc join is therefore poorly fixed by the data, and moving one click can shift it by
  a few G at almost no change in error.
- Curvature from three clicks. For clicks spaced h apart with noise σ, the curvature from three
  consecutive points has noise about 2.45 σ/h². At h = 3 G and σ = 0.075 G (1.5 px at G = 20 px)
  that is about 0.02 per G, against a signal of 0.033 per G for R = 30 G. Point-by-point curvature
  from clicks is too noisy to classify parts; it must be averaged over many points, which blurs the
  joins.

A fact all methods share: a G1 sequence of straights and arcs is fixed by a start point, a start
heading, and a length and a curvature for each part (curvature zero for a straight). Schindler et
al. state the same count: "a smooth arc spline with n segments can be stored with only 2n + 3
floating-point numbers" (IV 2012). Heading along the line is then a continuous function of arc
length that is piecewise linear; a straight is a flat piece. Fitting in these parameters gives
tangency without any constraint equations. This is used in recommendations 1 and 2.

---

## Methods

### 1. Curvature and heading diagrams (road and rail practice)

How it works. Survey practice computes curvature (or heading) along the measured centreline and
reads the parts off the diagram: straights are zero curvature, arcs are constant curvature,
transition curves are ramps. Koc (Sensors 23(1):274) computes curvature by a moving chord and
"Based on the curvature diagram, the coordinates of the segmentation points ... were determined"
for a 5.5 km railway section. Camacho-Torregrosa et al. (CACAIE 2015, 30(4):282–299) describe the
alignment "as a sequence of headings" instead, "unlike current methods that represent road
alignment through its curvature", and claim unique solutions for complex alignments. Imran et al.
(CACAIE 2006) extract tangents, spirals and circular curves from GPS in a GIS tool; Lipar et al.
(BJRBE 2011) smooth GPS with B-splines before fitting circles. Castro et al. (Railway Engineering
Science, 2024) pose two constrained optimisation problems on a geometric model of the alignment
and solve them in two stages; only the abstract could be read.

Straight against curve. A threshold on smoothed curvature, or flat against sloped pieces in the
heading diagram. The threshold is set by hand.

Compound and reverse curves. Yes: a step in curvature, or a sign change.

Stability. Poor at this point count (derived above): three-point curvature from clicks has noise
of the same size as the signal. Smoothing enough to threshold it moves the joins. Parts flip
between straight and arc wherever smoothed curvature sits near the threshold. The heading form is
better (one derivative instead of two), and fitting a continuous piecewise-linear function to
heading against arc length is exactly a G1 straight-and-arc fit. But a fit in heading space does not
bound the position error, because heading errors add up along the line; it needs a refit in
position.

Cost. Trivial for 50 points.

Implementations. None found in JavaScript or TypeScript. The surveyed tools are ArcView extensions,
MATLAB, or unpublished.

Use here. As a way to get a first segmentation for a refit, not as the fit.

### 2. Fewest parts within a tolerance band (computational geometry)

How it works. Build a band of half-width ε around the clicked polyline and find a curve inside it
with the fewest parts.

- Drysdale, Rote & Sturm (CGTA 41 (2008) 31–47; EWCG 2006 version read) build "a directed graph of
  all possible arcs and look for the shortest path from the start point to the end point", in
  O(n² log n). Arcs may be straights ("circles of infinite radius"). "The endpoints of the arcs are
  vertices of P", and consecutive arcs are not required to be tangent. Their tangent-continuous
  version uses biarcs and needs "a sequence of points with given tangent directions", in
  O(n² log² n).
- Maier ("Smooth Minimum Arc Paths", dissertation, Passau) solves the G1 case without fixed
  breakpoints: "a start-destination smooth arc path with the minimal possible number of segments",
  "an O(n²) algorithm", "even sub-quadratic" in practice. The algorithm is greedy: a forward pass
  builds arcs that touch the band edges alternately left and right, and a backward pass builds the
  path (Schindler, Maier & Janda, IV 2012). Maier notes that "a minimum arc path ... is not
  generally unique, but the minimum number of segments is naturally unique." On a sine test, it
  needs 2–29 parts where Yang's biarc method needs 23–45 (dissertation Table 5.2).
- The same group's DFG project page notes that minimum-count methods "deal with the supremum norm"
  without least-squares smoothing. Follow-ups by Maier (CAGD 31 (2014) 211–226, "Optimal arc
  spline approximation") and Maier, Janda & Schindler (ICIP 2012, "Minimum description length arc
  spline approximation of digital curves") were not reachable beyond their titles.

Straight against curve. Not decided. A straight is a circle of infinite radius; the method takes
whichever fits the band. A gentle arc of large radius comes out wherever a straight would also do.

Compound and reverse curves. Yes, without cost beyond the part count.

Stability. Weak for this use. The count is unique but the shape is not. The construction places
each arc against the band edges (the "alternating restrictions"), so the result sits at the
tolerance limit in several places by design, which works against "looks right". Greedy breakpoints
can move a long way when one point moves, and the count jumps by one when a point crosses the band.
Schindler et al. call the method suited to offline map building: it "doesn't satisfy real time
requirements" for their data sizes.

Cost. O(n²) for SMAP; fast enough for 50 points.

Implementations. None public in any language that I found. Held's group reports biarc fitting in
tolerance bands (Held & Eibl, CAD 37(4) 2005; Heimlich & Held, IJCGA 18(3) 2008) but gives no code
and no minimality claim. SMAP is a 237-page dissertation of geometry (circular visibility
diagrams); porting it is a project, not a prototype.

### 3. Least-squares arc splines and biarcs

How it works.

- Biarcs join two points with given tangents by two arcs. Meek & Walton approximate "a smooth curve"
  by an arc spline "arbitrarily close" (JCAM 59 (1995) 221–231) and discrete data by G1 arc splines
  (CAD 24(6) 1992); only the 1995 abstract was reachable. Biarc methods need a tangent at each data
  point, which clicks do not give, and they use two arcs per gap: Jeon et al. report a biarc method
  that needed about one arc per four data points.
- Jeon, Hwang & Choi (CAGD 112 (2024) 102363) fit G1 arcs by constrained nonlinear least squares
  (Gauss-Newton with Lagrange multipliers, MATLAB `lsqnonlin`). They get a starting count from a
  recursive split into lines (split at the point of largest error until within a threshold), merge
  neighbouring lines while one arc fits, then optimise. If any arc fails a χ² test on its points,
  "the arc segment with the most number of invalid data point approximations is halved" and the
  whole fit is run again, one part at a time.

Straight against curve. Jeon et al. fit arcs only; straights are not a separate type. A straight
needs an explicit choice, for example by Kanatani's test below.

Compound and reverse curves. Yes.

Stability. A least-squares fit moves smoothly when one point moves, as long as the part count and
types stay the same. The count steps when the worst error crosses the threshold. The fit has
local minima; a warm start from the previous fit (the natural case when one point is dragged)
helps.

Cost. Jeon et al. give no timings. For 50 points and up to 8 parts there are at most 19 unknowns;
each Gauss-Newton step solves a 19×19 system. Tens of iterations take well under a millisecond.

Implementations. None for arc splines in JavaScript or TypeScript. General solvers: npm
`ml-levenberg-marquardt` 5.1.0 (MIT) fits y = f(x) and needs adapting to point-to-curve residuals;
a hand-written Gauss-Newton with a dense solve is about as short. Circle fits are closed-form
(algebraic fits such as Kåsa, Pratt or Taubin); npm `circle-fit` 1.0.2 (MIT) has one.

### 4. Choosing the number of parts: penalties and dynamic programming

How it works. Write the cost of a split as the sum of each part's squared error plus a fixed cost
per part, and find the best split by dynamic programming over the points. Bellman did this for
straight segments (CACM 4(6):284, 1961). Jackson et al. give the general "optimal partitioning"
recursion for any additive cost with a per-block penalty, O(n²) (IEEE SPL 12(2):105–108, 2005).
PELT prunes it to expected linear time under conditions (Killick, Fearnhead & Eckley, JASA 107
(2012) 1590–1598); at n = 50 pruning is not needed. Horng & Li apply dynamic programming to lines
and circular arcs on digital curves (PRL 22 (2001) 183–197; title only), as do Pei & Horng for arcs
(PR 29(3) 1996; abstract only).

The per-part cost is where model selection comes in. With click noise σ and n points, BIC
(Schwarz, Ann. Statist. 6(2) 1978) charges σ² ln n per extra parameter. A straight part adds one parameter (its
length), an arc adds two (length and curvature). So an arc beats a straight on a part only if it
lowers the squared error by more than about σ² ln n (about 4σ² for 50 points), and a new part pays
for one or two more parameters. Kanatani shows why some such cost is required: a straight is a
special arc, so "a higher-order feature with a larger degree of freedom always has a smaller
distance measure", and an arc always wins on error alone. His geometric AIC prefers a line to a
circle through the same two endpoints when D_line / D_circle < 1 + 2/(N − 2), where D is the sum
of squared distances of the N − 1 points between the endpoints; this form needs no noise estimate
(Kanatani, PAMI 19(12) 1997). Rosin & West's earlier
method splits at the point of largest deviation and merges by a "significance" ratio of deviation
to length; Kanatani notes it settles straight against arc "by heuristics".

The constraint that must be handled: dynamic programming needs each part's cost to be independent
of its neighbours, but tangency couples them. The usual way round, and the one used by the road and
rail papers above, is two stages: segment with independent fits, then refit all parts together
with tangency. In the parameters given in "The problem in numbers" (start point, start heading,
length and curvature per part), the refit has no constraints at all.

Straight against curve. By the penalty: an arc must earn its extra parameter.

Compound and reverse curves. Yes; each costs one part.

Stability. Moving one point changes only the cost of the parts that contain it. The best split can
still change, and it does so where two choices are close in cost: a gentle arc whose sagitta is
near the noise, and the straight-to-arc join, which the data fix poorly (derived above). A small
extra cost for changing a part's type or the count relative to the previous fit would hold the
result steady while a point is dragged. That is a suggestion from this note, not from a source.

Cost. Fitting a straight and a circle to every run of points is O(n²) runs × O(n) points, about
10⁵ point operations at n = 50, or O(n²) with running sums. The DP itself is O(n²).

Implementations. None for this combination. The DP is about 30 lines.

### 5. Spiro (Levien)

How it works. Spiro is "an interpolating spline based on spirals" (`raphlinus/spiro` README). The
curve passes through every control point. Between points it uses Euler spirals (curvature linear
in arc length, G2) or higher-order spirals (G4), solved by Newton iteration on a band matrix
(`ppedit/spiro.c`). Each point has a type: corner `v`, G4 `o`, G2 `c`, and the one-sided points
`[` and `]`. libspiro's README: `[` is "used to connect a curve to a straight line" and `]` is
"used to connect a straight line to a curve"; a pair of them brackets a straight. Levien
introduced these one-way constraints because with plain Euler spirals "the segment adjoining the
corner point tends to be a circular arc segment, rather than being constrained to be a straight
line" (thesis §4.6.3), and because they "isolate sections of extreme changes of curvature" (§7.1).
Sections between corner points with no smooth knot are straight, and with one smooth knot are
circular arcs (§4.6.3).

Straight against curve. Not decided by Spiro. The person marks straights with `[` and `]`.

Compound and reverse curves. Curvature is continuous, so a change of radius is a spiral ramp, not a
step. The output is not a sequence of arcs; it resembles track with easements.

Stability. Good locality: moving one point changes the curve everywhere, but the effect falls by a
factor of 2 + √3 ≈ 3.73 per point away from it for the Euler spiral spline (thesis §2.6). Click
noise is not removed: every click is on the curve, so a click 1 px off puts a curvature wiggle
into the line. Levien also notes that an Euler spiral spline does not exist for every point
configuration (thesis §4.6.4).

Cost. Linear in the number of points per Newton step; fast.

Implementations. npm `spiro` 3.0.1, TypeScript port by be5invis (`be5invis/spiro-js`), Apache-2.0
or MIT, same as Levien's original. npm `libspiro-js` is GPL-3.0. libspiro (C, FontForge) is GPL.

---

## Comparison

| Method | Straight against curve | Compound / reverse | Change when one point moves | Cost, 50 points | JS/TS implementation |
|---|---|---|---|---|---|
| Curvature or heading diagram | Threshold on smoothed curvature | Yes | Flips near threshold; curvature from clicks is noisy | Trivial | None |
| Fewest parts in a band (Drysdale et al.; SMAP) | Not decided | Yes | Count unique, shape not; result touches the band edge | O(n²), fast | None; SMAP is hard to port |
| Least squares, growing count (Jeon et al.) | Not decided (arcs only) | Yes | Smooth until the count steps | Under 1 ms | None; small solver needed |
| Penalised DP, then G1 refit | Penalty per parameter (BIC or Kanatani) | Yes, cost per part | Local; flips where two choices are close | Under 1 ms | None; about 30 lines for the DP |
| Spiro | The person marks it | Spiral ramps, not arcs | Local (factor 3.73 per point); keeps click noise | Fast | npm `spiro`, Apache-2.0 or MIT |

---

## Recommendation for #290, and what each needs from the person

1. Penalised DP segmentation, then a joint G1 refit.
   - Fit a straight (total least squares) and a circle (algebraic fit) to every run of consecutive
     clicks. Keep only fits whose worst point is within t.
   - DP over the clicks: cost = squared error + c per part + one more parameter's cost for an arc.
     With σ known, c ≈ σ² ln n per parameter (BIC).
   - Refit all parts at once in start point, start heading and (length, curvature) per part, with
     straights held at zero curvature. Gauss-Newton or Levenberg-Marquardt. Check the worst point
     against t; if it fails, add a part where the error is worst and refit.
   - When a point is dragged, start from the previous result and charge a small cost for changing a
     part's type or the count.
   - From the person: the tolerance t (default 0.25 G, or smaller for "looks right") and the click
     noise σ (a default such as 0.05–0.1 G can come from G). The prototype should show both as
     sliders so the user can judge.
2. Fewest parts that meet the tolerance.
   - Same refit. Start with one part (or with the parts from a line split, as Jeon et al. do).
     While the worst point exceeds t, halve the part with the most points outside t and refit.
   - Afterwards set each part's curvature to zero, refit, and keep the straight if the worst point
     still meets t (or if Kanatani's ratio test prefers it).
   - From the person: the tolerance t only. Expect the count to change as a dragged point crosses
     the tolerance, and the result to use the whole tolerance where the count is tight.
3. Not in #290: Spiro, kept for the hand-correction question in #287 (forcing a part straight) and
   for easements. The fewest-parts geometry of SMAP and Drysdale et al. is not worth porting for
   tens of points: method 2 reaches a near-minimal count with far less code, and the refit gives
   the best fit at that count, which SMAP does not.

Drawing does not change: an arc can still be drawn as one cubic with `segment()` in
`ui/src/track.ts`, which follows a circular arc when the two headings are symmetric about the
chord.

---

## Not verified

- Full texts of Castro et al. 2024, Koc 2023, Camacho-Torregrosa et al. 2015, Horng & Li 2001,
  Meek & Walton 1992, Maier 2014 and Maier, Janda & Schindler 2012 were not read. In particular,
  whether Castro et al. choose the number of parts themselves is not known.
- The stability statements for methods 1 and 2 above are reasoning, not measurements. #290 is
  where they get tested.
- Typical click noise σ on the user's photos is not measured. The figures above assume
  σ ≈ 0.075 G.

## Sources

- R. L. S. Drysdale, G. Rote, A. Sturm, "Approximation of an open polygonal curve with a minimum
  number of circular arcs and biarcs", CGTA 41 (2008) 31–47.
  [Abstract and PDF](https://page.mi.fu-berlin.de/rote/Papers/abstract/Approximation+of+an+open+polygonal+curve+with+a+minimum+number+of+circular+arcs+and+biarcs.html)
- G. Maier, "Smooth Minimum Arc Paths. Contour Approximation with Smooth Arc Splines",
  dissertation, Univ. Passau. [PDF](https://www.forwiss.uni-passau.de/extern/doc/dissertation_maier.pdf);
  [project page](https://www.forwiss.uni-passau.de/en/projects/80/)
- A. Schindler, G. Maier, F. Janda, "Generation of High Precision Digital Maps using Circular Arc
  Splines", IEEE IV 2012. [PDF](https://www.forwiss.uni-passau.de/extern/doc/IV_2012.pdf)
- G. Maier, "Optimal arc spline approximation", CAGD 31 (2014) 211–226, doi:10.1016/j.cagd.2014.02.011.
- G. Maier, F. Janda, A. Schindler, "Minimum description length arc spline approximation of
  digital curves", ICIP 2012, 1869–1872, doi:10.1109/ICIP.2012.6467248.
- J. Jeon, Y. Hwang, S. B. Choi, "Reliability-based G1 continuous arc spline approximation", CAGD
  112 (2024) 102363. [arXiv 2401.09770](https://arxiv.org/abs/2401.09770)
- D. S. Meek, D. J. Walton, "Approximation of discrete data by G1 arc splines", CAD 24(6) (1992)
  301–306; "Approximating smooth planar curves by arc splines", JCAM 59 (1995) 221–231.
- M. Held, J. Eibl, "Biarc approximation of polygons within asymmetric tolerance bands", CAD 37(4)
  (2005) 357–371; M. Heimlich, M. Held, IJCGA 18(3) (2008) 221–250.
  [Project page](https://cosy.sbg.ac.at/~held/projects/apx/apx.html)
- K. Kanatani, "Comments on 'Nonparametric Segmentation of Curves Into Various Representations'",
  PAMI 19(12) (1997) 1391–1392. [PDF](https://iim.cs.tut.ac.jp/member/kanatani/papers/PAMIrosin.pdf);
  P. L. Rosin, G. A. W. West, PAMI 17(12) (1995) 1140–1153.
- J. H. Horng, J. T. Li, "A dynamic programming approach for fitting digital planar curves with
  line segments and circular arcs", PRL 22 (2001) 183–197.
- R. Bellman, "On the approximation of curves by line segments using dynamic programming", CACM
  4(6) (1961) 284.
- B. Jackson et al., "An algorithm for optimal partitioning of data on an interval", IEEE SPL 12(2)
  (2005) 105–108.
- R. Killick, P. Fearnhead, I. A. Eckley, "Optimal detection of changepoints with a linear
  computational cost", JASA 107 (2012) 1590–1598.
- W. Koc, "The Procedure of Identifying the Geometrical Layout of an Exploited Railway Route Based
  on the Determined Curvature of the Track Axis", Sensors 23(1) 274 (December 2022), doi:10.3390/s23010274.
- F. J. Camacho-Torregrosa et al., "Use of Heading Direction for Recreating the Horizontal Alignment
  of an Existing Road", CACAIE 30(4) (2015) 282–299. [Record](https://riunet.upv.es/handle/10251/56864)
- A. Castro, G. Casal, D. Santamarina, M. Vázquez-Méndez, "A simple method for automatic recreation
  of railway horizontal alignments", Railway Engineering Science (2024), doi:10.1007/s40534-024-00348-2.
- M. Imran, Y. Hassan, D. Patterson, "GPS–GIS-Based Procedure for Tracking Vehicle Path on
  Horizontal Alignments", CACAIE 21(5) (2006) 383–394. [Record](https://trid.trb.org/View/786413)
- P. Lipar et al., "Estimation of Road Centerline Curvature from Raw GPS Data", BJRBE 6(3) (2011).
  [Record](https://bjrbe-journals.rtu.lv/article/view/bjrbe.2011.21)
- R. Levien, "From Spiral to Spline: Optimal Techniques in Interactive Curve Design", PhD thesis,
  UC Berkeley, UCB/EECS-2009-162. [PDF](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2009/EECS-2009-162.pdf)
- [`raphlinus/spiro`](https://github.com/raphlinus/spiro) (Apache-2.0 or MIT);
  [`fontforge/libspiro`](https://github.com/fontforge/libspiro) (GPL);
  [`be5invis/spiro-js`](https://github.com/be5invis/spiro-js), npm `spiro` 3.0.1 (Apache-2.0 or MIT).
- npm `ml-levenberg-marquardt` 5.1.0 (MIT), `circle-fit` 1.0.2 (MIT).
