# PRD: Render Wait Experience — Style Preference Collection

**Owner:** Product
**Audience:** Design (US), Engineering, Growth
**Status:** Draft v1
**Date:** April 30, 2026

---

## 1. TL;DR

When a user submits a room redesign, the render takes 3–4 minutes. Today, that time is dead — the user stares at a "Matching furniture to your style" placeholder. We are turning that wait into an active preference-collection surface ("Explore") where users browse curated and community rooms, signal what they like, and build a style profile. The output: lower abandonment during the wait, a richer personalization signal that improves the first redesign and every redesign after, and a steady supply of behavioral data that compounds across the product.

This is not a loading screen with content stuffed into it. It is a real surface that happens to be reachable from the wait state.

---

## 2. Context & Problem

### What exists today
After a user uploads a room photo and submits a prompt, the left panel shows a static placeholder with the message "Matching furniture to your style" and outline icons of furniture. The right panel keeps the chat thread visible. See attached screenshot for the current state.

### Why this is a problem
- **3–4 minutes is too long for a passive wait.** Users either tab away (and may not come back) or sit and watch nothing happen. Both are bad outcomes.
- **We are not collecting any signal during this window.** Style preference is the single most valuable input to a furniture redesign. The wait is the highest-attention, lowest-friction window we will ever have to ask for it.
- **Cold-start data is thin.** New users have no transaction history, no behavioral signal, and no saved boards. We're rendering their first redesign with almost nothing to personalize on.

### Why now
The render latency is a structural cost in the near term. Rather than design twice (once for slow, again for fast), we should build a wait-state surface that is valuable independent of latency — so when render time drops, the surface remains useful as a standalone Explore experience.

---

## 3. Goals & Non-Goals

### Goals
1. Reduce abandonment during the render wait.
2. Collect structured style preference data on every render session.
3. Improve perceived quality of the first redesign by personalizing it on signals collected during the wait.
4. Build a surface that is valuable on its own and can later be promoted to a primary entry point.

### Non-goals
- This is not a re-architecture of the chat flow. Chat remains the refinement surface post-render.
- We are not building a full Pinterest-style infinite feed in v1. Tight, curated card stack only.
- We are not changing the upload or prompt flow. Entry point is unchanged.

---

## 4. User Flow

1. User uploads a photo and submits a prompt (existing flow, no change).
2. Render kicks off. Left panel transitions from current placeholder → **Explore surface**.
3. User sees a stack of curated room cards. Each card has a clear hero image and minimal metadata (style tag, room type).
4. User reacts to each card: **Like**, **Dislike**, or **Save**. Each action advances to the next card.
5. A persistent progress indicator shows render status ("Your room is 60% ready").
6. Style profile visualization updates in real time as the user reacts (e.g., "You're leaning warm minimalist").
7. When render is complete, a non-blocking notification appears in-surface: "Your redesign is ready — view it." User can continue exploring or jump to the result.
8. If user enables push notifications, they can leave the session entirely and be notified when render is done.

---

## 5. UX Requirements

### 5.1 Layout

The right-side chat panel stays as-is. **The left panel is what changes.**

During the wait state, the left panel transforms:
- **Top bar (existing):** Add Category, Budget, Filter — keep visible but de-emphasized (lower opacity, secondary state). Reason: user is mid-flow, not editing inputs.
- **Tab row (existing):** Room | Saved | Sofas | Accent Chairs | Ottomans | TV Stands | Chaises — keep visible.
- **Main content area:** Replace the current "Matching furniture to your style" placeholder with the Explore surface (described below).
- **Bottom row of empty product slots (existing):** Repurpose as the **Style Profile strip** (described in 5.4) or hide entirely until render completes.

### 5.2 Explore card stack

The primary component. A vertically stacked or single-card-at-a-time view of curated rooms.

**Card anatomy:**
- Hero image (full-bleed room photo, 4:3 or 3:2 ratio)
- Style tag chip (e.g., "Warm Minimalist", "Mid-Century Modern", "Coastal")
- Room type chip (e.g., "Living Room", "Bedroom", "Studio")
- Three actions: **Dislike** (X), **Save** (heart/bookmark), **Like** (check or thumbs)
- Optional: small secondary text — "12 products inside"

**Interaction:**
- Single tap on action → advances to next card with a light animation (slide or fade, designer's call)
- Tap on the card image itself → opens a quick preview overlay showing the products in the room (don't leave the surface)
- Save action has a heavier visual treatment than Like/Dislike (it's a higher-intent signal and should feel distinct)

**Stack depth:**
- Show 8–12 cards per render session. Don't make this an infinite feed in v1 — we want users to also engage with the render result, not get lost.
- After the last card, show a soft end state: "Your room is almost ready" with a CTA to wait or get notified.

### 5.3 Card content sourcing

Cards must come from a curated pool. For v1:
- ~200 hand-picked rooms across 8–10 style clusters
- Mix of room types weighted to user's submitted room (if they uploaded a living room, weight toward living rooms but include adjacent types for breadth)
- Each room is tagged with: style cluster, room type, color palette, dominant materials

Community/UGC content flows into this pool in a later phase once the sharing loop is producing volume.

### 5.4 Style profile visualization

A persistent component that updates as the user reacts. Lives either as a thin strip below the Explore stack or in the area where empty product slots currently sit.

**v1 minimum:**
- Plain-language summary that updates after every 3–5 reactions: "You're leaning toward warm tones and natural materials" or "Mid-century modern with a soft palette"
- Visual indicator of progress: "5 of 10 rooms reviewed"

**v1.5 (if scope allows):**
- Small color palette swatches that emerge from liked rooms
- Top 3 style tags with confidence weighting

This is the hook that makes the wait feel valuable. Users see their taste being learned in real time. Designer should treat this as a primary affordance, not a footnote.

### 5.5 Render progress indicator

A persistent, non-intrusive element that communicates render status without dominating the screen.

**Requirements:**
- Always visible, top of the left panel or anchored to the bottom
- Shows percent complete OR estimated time remaining (whichever is more accurate from the backend)
- Subtle progress animation (not a spinning loader — something that feels like progress)
- Color-shifts or pulses gently as it nears completion

### 5.6 Render-ready transition

When the render completes:
- Progress indicator transitions to a **"View your room"** CTA (full-width or prominent button)
- The Explore surface remains accessible — user can choose to view the result or keep exploring
- If user clicks through, the room they were on in Explore is preserved (don't lose state)
- If they enabled push notifications and have left the session, the notification is the entry back

### 5.7 Notification opt-in

Surface a one-time prompt early in the Explore flow (after card 2 or 3, not on card 1):
- "We'll let you know when your room is ready — turn on notifications?"
- Single tap to enable. Don't block the flow if declined.
- Don't ask again in the same session.

---

## 6. Content & Personalization

### 6.1 Card ranking

For v1, cards are pulled from the curated pool with light personalization:
- If user's submitted prompt mentions a style ("modern", "boho", "minimal"), bias toward matching cards
- If user's uploaded photo has detectable color/style signals, bias toward complementary cards
- Otherwise, default to diverse style coverage so we maximize signal

For v2, ranking shifts to model-driven based on accumulated user signal across sessions.

### 6.2 What we capture per reaction

Each user action (Like / Dislike / Save) writes:
- Card ID
- Reaction type
- Style cluster of the card
- Room type
- Color palette tags
- Material tags
- Timestamp
- Session ID
- Whether the reaction came during a render wait or in a standalone Explore session

### 6.3 How signal feeds back into the redesign

This is the loop that makes the wait worth it.

- Reactions collected during the wait are passed to the redesign model **before** the render completes (if backend latency allows) or applied as a post-render re-ranking of suggested products
- Saved rooms become candidate references for product selection inside the user's redesigned room
- Style profile is persisted to the user account and informs every future session

Engineering: confirm what's feasible mid-render vs. post-render.

---

## 7. Edge Cases

- **User reacts to zero cards.** Render completes normally. No personalization signal added. Don't penalize.
- **User reaches end of card stack before render completes.** Show waiting state with profile summary and notification opt-in. Don't loop the same cards.
- **User leaves the page entirely.** Render continues server-side. If notifications are enabled, push when ready. Otherwise, surface result on next visit.
- **Render fails.** Explore session is preserved. User sees a clear error with a retry CTA. Reactions collected are still saved.
- **Render completes faster than expected (<60s).** Skip the full Explore experience. Show a brief 3-card mini-flow or skip entirely. Don't force users to wait through Explore for the sake of collecting signal.
- **User on a slow connection.** Card images must be aggressively optimized (LQIP or blurhash). Surface should be usable without all images loaded.
- **Returning user with established style profile.** Skip basic preference cards, show edge cases or new clusters to refine the profile.

---

## 8. Out of Scope (v1)

- Community/UGC rooms in the card pool (Phase 2, after the sharing loop is producing volume)
- Drilling into individual products within a card (separate Saved Products flow)
- Multi-room style profiles (one global profile in v1)
- A/B testing different card densities or layouts (start with one design, iterate from data)
- Offline mode

---

## 9. Open Questions

1. **Should Explore be reachable outside of the wait state in v1?** Recommendation: build it as a real surface that is *primarily* surfaced during the wait, with a secondary entry point in the nav. Low effort to add the entry point; high optionality.
2. **Do we show the render in progress visually (e.g., a small thumbnail that updates)?** Possibly compelling but adds backend complexity. Defer to v2.
3. **What's the right number of cards before "ending" the stack?** Start at 10. Tune based on completion rate.
4. **Is Save the same as adding to the current Board, or to a separate Saved Rooms collection?** Recommendation: separate Saved Rooms collection. Boards are project-scoped; Saved Rooms is taste-scoped.

---

## 10. Success Metrics

**Primary:**
- % of render sessions where user reacts to ≥3 cards
- Reduction in render-wait abandonment (% who leave the tab and don't return within 24h)
- Lift in first-redesign satisfaction (measured via post-render rating or save-to-board rate)

**Secondary:**
- Average reactions per session
- Save rate (high-intent signal)
- Notification opt-in rate
- Cross-session retention for users who built a style profile vs. those who didn't

**Diagnostic:**
- Cards-per-session distribution
- Drop-off curve through the card stack
- Time-to-first-reaction

---

## 11. Reference

Current state screenshot attached. Left panel is the surface that changes. Right panel (chat) stays as-is.
