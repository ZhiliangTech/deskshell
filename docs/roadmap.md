# Local agent system roadmap

The first product runs on existing Windows PCs. “Local” describes the task host, runtime, and execution on the user's computer; current model integration uses a cloud API to interpret intent and propose work. The runtime controls permissions, execution, verification, and recovery, and the desktop interface makes task state visible. Local inference adapters remain part of the long-term direction. Broader platforms and dedicated devices follow evidence from this product.

The product direction is decided. The detailed engineering proposal is [RFC 0001](../rfcs/0001-local-agent-system.md), currently a Draft in Chinese. The stages below are acceptance gates. Some foundations are implemented; that does not complete an entire stage.

The [project overview](../PROJECT.md) records the confirmed vision and product scope. The [decision register](zh-CN/decisions.md) separates confirmed directions from open decisions. Both are in Chinese. The two research directions below are confirmed; their detailed protocol remains Draft and their benefits still require experimental evidence.

## Current foundation

- Reuse Action v0, the execution kernel, file skills, Windows UIA, the shared driver factory, CLI, MCP server, and Windows panel.
- Existing tests cover assertions, compensation, and auditing. See [STATUS](../STATUS.md) for current results and the limits of real desktop validation.
- The old natural-language entry point still uses rules. The new `agent` CLI uses a resident service for fixed photo plans, exact approval, goal verification, conditional undo, and control from another process. It also includes a dedicated Notepad task runtime and a coordinator for multiple rounds within one approved scope. Real DeepSeek calls with a synthetic editor completed three rounds. Fixed native Notepad plans passed the complete service IPC, task host, and driver chain for CRLF and LF; local-planner and real DeepSeek native three-round runs, four native fault checks, and the default production service also passed. The exact version/locale profile is enabled. IPC separates task and control credentials, and calls share a persistent per-user daily budget. Old-entry-point migration, a clarification interface, general planning, and selective recovery remain; see the [file task](zh-CN/agent-file-task.md), [multi-round task](zh-CN/autonomous-tasks.md), [host](zh-CN/task-runtime.md), and [recovery notes](zh-CN/task-recovery.md) (Chinese).
- Skills currently execute as trusted TypeScript code. Capability declarations do not sandbox third-party code.

## Stages and acceptance

| Stage | Delivery | Acceptance gate |
| --- | --- | --- |
| G1 Fixed plans and shared entry points | Minimal per-user host, persistent plan/approval/execution records, TaskService | Execute the approved plan; reject changed plans; prevent duplicates across concurrent requests and restarts; block model-issued approval |
| G2 Step persistence and recovery | Step events, recovery materials, resource locks, cancellation | Reconcile executed/unexecuted/unknown effects after interruption; avoid blind replay and overwriting external edits |
| G3 Agent loop on the local runtime | One cloud-model API adapter, observations, clarification, bounded replanning; an interface for future local adapters | Real inference participates; invalid output has no effects; disconnection stops new inference and produces a clear error; local history, stop, and recovery remain available; cancellation and budgets work |
| G4 Resident desktop product | Startup integration, panel, history, recovery view, Windows Notepad workflow | Validate the approved Notepad workflow, window replacement, and human interference; external users complete agreed tasks independently |
| G5 Extensions and devices | Third-party isolation, MCP client, platform and device profiles | Verify isolation and effect contracts before opening untrusted extensions; select device form from measured needs |

G1–G4 together define the first user-facing product. Read-only model experiments can run alongside G1; model-driven writes must use the prepared-plan and approval path. Preserve macOS/Linux compatibility while using Windows as the initial release gate.

The initial default is the DeepSeek official API with `deepseek-flash`; see [model backends](zh-CN/model-backends.md) (Chinese). A photo plan is limited to one request, 512 output tokens, 30 seconds, and USD 0.01 estimated cost. An application session defaults to six rounds, allows 3–10 rounds, and has a five-minute deadline and USD 0.05 backend-instance estimate limit. Both share a per-user UTC-day allowance of 10 requests/USD 0.10 across task directories and restarts. The three real-model rounds with a synthetic editor used 889/912/895 tokens, totaling 2,696 tokens and USD 0.0038343 estimated cost, not an invoice. There are no automatic retries. A clarification interface, general planning, and full G1–G4 acceptance remain incomplete. Cloud inference stops offline; local history, cancellation, and evidence-based file recovery remain available.

## Two research tracks alongside G1–G3

The proposed contracts and experiments are in [RFC 0002 — Semantic resources and effect receipts](../rfcs/0002-semantic-resources-and-effect-receipts.md), currently Draft in Chinese.

| Track | Research question | Relationship to delivery |
| --- | --- | --- |
| Main track: versioned semantic resource views | Can a bounded resource view with stable identity, state version, available operations, and provenance improve planning and stale-observation detection, first with a cloud model and later with local models? | Alongside G1, define how observations and resource versions bind to a prepared plan. In G2, test changes and conflicts. G3 establishes a real cloud-model baseline using raw file/UIA observations; later local-adapter work independently replicates the comparison. |
| Supporting track: effect receipts and selective recovery | Can verified effect records and dependency information identify what actually changed and which changes can be safely recovered without overwriting unrelated work? | Alongside G1, define the proposed effect and receipt boundary. In G2, test receipts, interruption, conflicts, and recovery dependencies. In G3, expose grounded outcomes and recovery options to the task loop. |

These tracks do not postpone the first complete workflow or bypass its approval requirements. Selective recovery must reject or defer unsafe dependency combinations; receipts do not make irreversible effects reversible.

Evaluate semantic resource views independently of implementation unit tests through real cloud-API and Windows experiments. The primary effect-receipt and recovery experiments use deterministic file, JSON, and controlled-UI scenarios with fixed forward operations, independently of a model. Models participate later in combined end-to-end experiments, followed by separate local-model replication. Version the tasks, held-out inputs, baselines, and fault scenarios. Cloud comparisons must use the same provider, model/version, inference parameters, underlying operations, tool permissions, and budgets; record the API version information, experiment time, and token, tool-call, time, and spending limits. Keep and record the same client hardware for local observation and execution measurements, without claiming control of the provider's cloud compute. Recovery comparisons also use the same starting state, executed actions, and injected faults. Change one research component at a time before testing their combination. Cloud results cannot establish benefits for smaller local models; local replication must additionally control and record hardware, model artifacts, quantization, and inference backend.

Report task completion, stale-state/conflict detection, latency and resource use, recovery success, residual changes, and damage to unrelated work separately. Count refusals, deferred tasks, and unknown outcomes separately from successful completion or recovery. Mock checks establish contract behavior; they do not substitute for these experiments. A confirmed research direction is not a claim of measured improvement or an Accepted RFC.

## First complete workflow

The user selects a folder and asks to organize photos by month, place duplicates in a review folder, and preserve other files. The current system reads within the granted scope, previews concrete changes, executes the approved plan, rechecks the result, and provides history and conditional undo. CLI arguments currently enforce required information; an interactive clarification interface remains to be built.

Conflicts, human edits, write failures, cancellation, and process interruption are part of file-task acceptance. Three real-model rounds passed with a synthetic editor. Separately, fixed native plans passed the complete service chain in Notepad 11.2607.14.0: all three stages recorded verified native observations, Chinese paths and text, preserved blank lines, exact UTF-8 without BOM copies with CRLF or LF, and unchanged sources. The earlier screenshot tool's null accessibility was a tool limitation. Two earlier attempts stopped on detected desktop input and remain rejection records. Subsequent local-planner and real DeepSeek native runs completed three rounds, four native faults passed, and the default production service was independently verified. The real native run used 2,543 tokens and an estimated 0.0038316 USD, not an invoice. Production selection is enabled only for an exact 11.2607.14.0/zh-CN match. Each production host lifetime executes one document task; a later task needs a host restart and a new plan, without automatically closing Notepad windows. See the [first-application notes](zh-CN/first-application.md) (Chinese).

## Implemented foundations and next engineering work

1. TaskService, TaskResult, a resident file host, and separate approval credentials exist; improve installation, lifecycle, and desktop presentation.
2. Plans, goals, approvals, unique claims, and effect checkpoints are durable; define retention and disk quotas.
3. Conditional file undo and interruption recovery require exact approval and reject unknown effects; investigate native concurrency control and selective recovery separately.
4. Month grouping, full-content duplicate review, a shared daily budget, multiple rounds within fixed authority, and fixed native application execution exist; extend native fault and version/locale/encoding coverage, and add a clarification interface, general task planning, and held-out evaluation.
5. Migrate the old CLI, Shell, and MCP with consistency, v0 compatibility, and real-application acceptance. Only the new agent entry point currently shares the service.

RFC 0001 defines the proposed types, migration, and acceptance cases. Track fixture, cloud-model, local-model, Windows-hardware, and external-user evidence separately.

## Historical milestones

`goals/milestones.json` remains a historical development record, not the completion tracker for this roadmap. M08 demonstrates rules-based intent parsing; M04 demonstrates recorded fixtures replayed through MockDriver; M05 still needs its original UI/snapshot coverage; M09's automated installation test does not replace external-user acceptance. The new roadmap does not lower those original acceptance criteria. The legacy clock report must be labeled as the old plan when progress tracking migrates.
