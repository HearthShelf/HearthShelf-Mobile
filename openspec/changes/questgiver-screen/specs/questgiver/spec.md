## Purpose

The guided recommendation flow: a short set of questions about what a listener
is in the mood for, turned into a matched shortlist from their library and
optionally beyond it.

## ADDED Requirements

### Requirement: The flow asks four things

QuestGiver SHALL ask, in order: what to base the match on, which direction to
go, how to weight genres, and a set of fine-tuning preferences. The listener
SHALL always be able to go back and change an earlier answer.

#### Scenario: Progressing through the flow
- **WHEN** the listener answers a question
- **THEN** the next question is presented
- **AND** progress through the flow is visible

#### Scenario: Going back
- **WHEN** the listener goes back
- **THEN** the previous question is shown with their answer intact

#### Scenario: Basing the match on a chosen set
- **WHEN** the listener chooses to match against books they pick rather than
  their history
- **THEN** they can select books
- **AND** the flow does not continue until at least one is selected

#### Scenario: Answers reflect the listener's own library
- **WHEN** a question refers to genres, counts or listening habits
- **THEN** those come from the listener's own library and history

### Requirement: A run always produces results

A run SHALL produce a shortlist whether or not an AI provider is configured or
reachable. AI SHALL refine the result, never gate it.

#### Scenario: No AI configured
- **WHEN** the server has no AI provider configured
- **THEN** the run still completes and returns matched picks

#### Scenario: The AI call fails
- **WHEN** an AI provider is configured but the call fails for any reason
- **THEN** the run falls back to the deterministic recommender
- **AND** the listener still receives picks

#### Scenario: Which engine ran is visible
- **WHEN** results are shown
- **THEN** the listener can tell whether they were AI-matched or weight-matched

#### Scenario: The AI allowance is exhausted
- **WHEN** the configured AI allowance for the period is used up
- **THEN** the listener is told before starting a run

### Requirement: Looking beyond the library is not gated on the request backend

When the listener enables looking beyond their library, candidates from outside
it SHALL be searched, regardless of whether a request backend is connected.

#### Scenario: Enabled with no request backend connected
- **WHEN** the listener enables looking beyond their library and no request
  backend is connected
- **THEN** external candidates are still searched and may appear in results

#### Scenario: Acting on an external pick
- **WHEN** results include a pick the listener does not own
- **THEN** the offered action matches what the server can actually do -
  requesting it where a request backend is connected, otherwise a way to go and
  get it

#### Scenario: Disabled
- **WHEN** the listener leaves the option off
- **THEN** only books already in the library are considered

### Requirement: Results are actionable

Each pick SHALL show what it is and why it was chosen, and offer an action
appropriate to whether the listener owns it.

#### Scenario: A pick from the library
- **WHEN** a pick is a book in the library
- **THEN** the listener can start it or open its details

#### Scenario: Why a pick was chosen
- **WHEN** results are shown
- **THEN** each pick carries a reason

### Requirement: Feedback on a pick

A listener SHALL be able to say whether a pick was any good, and that feedback
SHALL inform later runs.

#### Scenario: Rating a pick
- **WHEN** the listener marks a pick as good or bad
- **THEN** the feedback is kept

#### Scenario: Feedback carries forward
- **WHEN** a later run is made
- **THEN** earlier feedback informs the result

### Requirement: Past runs are kept

Completed runs SHALL be browsable after the fact, with their picks and reasons.

#### Scenario: Reviewing an earlier run
- **WHEN** the listener opens past runs
- **THEN** earlier runs are listed newest first
- **AND** opening one shows its picks and reasons

#### Scenario: Runs follow the listener
- **WHEN** the listener uses another device against the same server
- **THEN** their past runs are available there

### Requirement: Consistent across clients

The questions asked, the ordering rules, and the availability of external
candidates SHALL be the same on mobile and both web apps.

#### Scenario: The same answers give the same shape of result
- **WHEN** a listener runs QuestGiver with the same answers on any client
- **THEN** the questions, the options, and the gating behaviour match
