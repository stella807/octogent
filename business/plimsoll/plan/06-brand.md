# Brand

## Name

**Plimsoll.**

The Plimsoll line is the mark on a ship's hull showing how heavily it may safely be loaded.
It was made compulsory in Britain in 1876 after Samuel Plimsoll campaigned against
"coffin ships" — vessels deliberately overloaded and over-insured, whose crews drowned.

The metaphor is exact, which is why the name works:

- It is about **load**, not prohibition. Nobody argues ships should carry nothing. The
  question is how much, and whether you can see the mark.
- It is a **visible, external, standard** mark — not a private opinion.
- The historical argument was **not that ships were bad.** It was that the people bearing
  the risk could not see how much of it they were carrying. That is the exact argument this
  product makes about agent-written code, and it is a better story than anything invented.

It also sits naturally beside the octopus-and-tentacles vocabulary this repository already
uses, without being a pun.

**Clearance status:** a UK entity, Plimsoll Productions Ltd, holds trademarks in
entertainment classes. No developer-tools conflict was found in searching. This is **not a
clearance opinion** — classes 9 and 42 must be cleared by counsel before spending on brand
assets. See `05-operations-and-legal.md`, step 1.

## Positioning statement

> For engineering leaders whose teams have adopted coding agents, Plimsoll is the
> measurement layer that shows what share of merged code an agent wrote and whether it
> fails more often than human-written code. Unlike AI code review tools, which inspect one
> pull request before merge, Plimsoll measures outcomes after merge and compares cohorts —
> because you cannot set a safe limit you cannot see.

## Voice

The category is saturated with alarming statistics used as sales pressure. The differentiated
position is the opposite: **be the instrument, not the alarm.**

**Do**
- Show the method before the finding. Publish how the number is computed, including where it
  is weak.
- Say "low confidence" when the sample is small. The product does this in its own output.
- Use the customer's own number, never an industry aggregate, whenever one exists.
- Report a reassuring result as readily as an alarming one.

**Do not**
- Imply AI-written code is bad. It is 42% of committed code; that argument is over and we
  would lose it.
- Use fear as the close. The buyer has been fear-sold all year and is inoculated.
- Report on named individuals, ever — in the product, in a demo, or in a deck.
- Claim precision the data does not support.

**Tone:** a competent colleague showing you a measurement, not a vendor showing you a threat.
Plain sentences. Numbers with their error bars attached.

## Messaging ladder

| Audience | Line |
| --- | --- |
| Engineer | "Find out what share of your repo an agent wrote. Runs locally, sends nothing." |
| Engineering leader | "Your change failure rate, split by whether a human or an agent wrote it." |
| CTO / VP Eng | "You cannot set a safe limit on agent-written code if you cannot see how much you are carrying." |
| Security / compliance | "Provenance and risk attribution for machine-written code, as an audit artefact." |

## Visual identity

- **Mark:** the load line itself — a horizontal line through a circle, with the short
  gradation marks of a real hull marking. Instantly legible at favicon size, and it is a
  chart and a logo at once.
- **Type:** a grotesque for UI and headings; a monospace for all numbers. Numbers are the
  product and should always look like data.
- **Colour:** deep hull navy as the ground, a waterline teal as the single accent, and a
  restrained amber used *only* for a load line above threshold. Alarm colour should be rare
  enough that it means something when it appears.
- **Charts:** one idea per chart, direct labels rather than legends, and a visible
  uncertainty band whenever confidence is low. The visual system must be able to express
  doubt — if it cannot, the brand's central claim is unsupported by its own design.

## Naming within the product

| Term | Meaning |
| --- | --- |
| **Load line** | Agent-authored share of merged lines |
| **Cohort** | Agent-authored or human-authored changes |
| **Risk ratio** | Agent failure rate ÷ human failure rate |
| **Above the line** | Agent cohort failing materially more (≥1.5×) |
| **Riding low** | Somewhat more (1.15–1.5×) |
| **Level** | No meaningful difference |
| **Below the line** | Agent cohort failing less (≤0.85×) |

These are the terms used in the CLI output, the product UI and all written material. One
vocabulary everywhere.
