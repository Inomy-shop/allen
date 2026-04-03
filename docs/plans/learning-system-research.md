# FlowForge Learning System: Comprehensive Research Report

## Agent Memory & Learning Systems Across Industry and Open Source

**Date:** April 2026
**Purpose:** Research how leading AI agent platforms implement learning/memory systems, to inform FlowForge's learning system design.
**Scope:** 15+ systems analyzed across production platforms, open-source frameworks, academic research, and AI coding agents.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System-by-System Analysis](#2-system-by-system-analysis)
   - 2.1 [LangGraph / LangChain](#21-langgraph--langchain)
   - 2.2 [CrewAI](#22-crewai)
   - 2.3 [Microsoft AutoGen](#23-microsoft-autogen)
   - 2.4 [Microsoft Semantic Kernel / Agent Framework](#24-microsoft-semantic-kernel--agent-framework)
   - 2.5 [OpenAI Assistants API & Agents SDK](#25-openai-assistants-api--agents-sdk)
   - 2.6 [Cognition (Devin)](#26-cognition-devin)
   - 2.7 [Cosine (Genie)](#27-cosine-genie)
   - 2.8 [Workflow Engines: Windmill, n8n, Temporal](#28-workflow-engines-windmill-n8n-temporal)
   - 2.9 [NVIDIA Voyager](#29-nvidia-voyager)
   - 2.10 [Reflexion / Self-Refine](#210-reflexion--self-refine)
   - 2.11 [MemGPT / Letta](#211-memgpt--letta)
   - 2.12 [Mem0](#212-mem0)
   - 2.13 [Zep (Graphiti)](#213-zep-graphiti)
   - 2.14 [Amazon Bedrock AgentCore Memory](#214-amazon-bedrock-agentcore-memory)
   - 2.15 [Claude Code](#215-claude-code)
   - 2.16 [Cursor AI](#216-cursor-ai)
3. [Comparative Analysis Table](#3-comparative-analysis-table)
4. [Cross-Cutting Themes and Patterns](#4-cross-cutting-themes-and-patterns)
5. [Recommendations for FlowForge](#5-recommendations-for-flowforge)
6. [Sources](#6-sources)

---

## 1. Executive Summary

The AI agent memory landscape in 2025-2026 has matured significantly. Systems have moved from simple chat history buffers to sophisticated multi-tier architectures with temporal awareness, contradiction handling, and scoped retrieval. The key findings are:

**Convergence on tiered memory.** Nearly every production system now implements at least two tiers: in-context (working) memory and out-of-context (persistent) memory. The best systems add a third tier -- graph-structured or relational memory for entity relationships and temporal facts.

**Extraction is the hardest problem.** Systems diverge most on how learnings are extracted. Three approaches exist: (a) agent self-reports learnings (Claude Code, FlowForge's current system), (b) a separate LLM pass extracts facts from conversation (Mem0, Zep, Bedrock AgentCore), (c) structured outputs are logged as skills (Voyager). Approach (b) is gaining traction as the most reliable.

**Contradiction handling separates production from prototype.** Mem0's ADD/UPDATE/DELETE/NOOP operations and Zep's temporal knowledge graph are the two leading approaches for handling facts that change over time. Systems without explicit contradiction handling (early LangGraph, basic CrewAI) accumulate conflicting memories that degrade agent performance.

**Scoping is essential at scale.** Every multi-agent system that works in production has some form of memory scoping -- agent-level, team-level, project-level, or organization-level. FlowForge's existing three-tier scoping (agent/team/org) is well-aligned with industry best practice.

**The OS metaphor is winning.** Letta/MemGPT's framing of LLM context as RAM and external storage as disk has become the dominant mental model, adopted explicitly or implicitly by LangGraph, Bedrock AgentCore, and others.

---

## 2. System-by-System Analysis

### 2.1 LangGraph / LangChain

**Overview:** LangGraph is LangChain's framework for building stateful, multi-actor agent applications using a graph-based computation model. It has emerged as one of the most widely adopted agent orchestration frameworks.

**Memory Architecture:**

LangGraph implements memory at two levels:

1. **Short-Term Memory (Thread State):** State is the living record of an agent's reasoning. Every input, intermediate thought, tool output, and decision is captured in a centralized state object accessible to all nodes. This state persists within a single thread (conversation) via checkpointing.

2. **Long-Term Memory (Cross-Thread Store):** Built on the `BaseStore` interface, long-term memory stores JSON documents organized by namespace and key. It supports cross-thread persistence -- storing and recalling information across different conversation sessions.

**Checkpointing System:**

LangGraph's checkpointing provides built-in persistence with support for multiple threads and time-travel (rewinding to prior states). Storage backends include:
- `InMemorySaver` -- development only, lost on process end
- `SqliteSaver` -- lightweight persistent storage
- `PostgresSaver` -- production-grade with pgvector for semantic retrieval
- `RedisSaver` -- high-performance cross-thread memory
- `MongoDBStore` -- flexible document-based persistence

**How Learnings Are Extracted:**

LangGraph itself does not extract learnings automatically. It is a state-management framework. Learning extraction must be built as custom nodes in the graph. Developers typically implement:
- Explicit memory-writing tool calls within agent nodes
- Post-execution summarization nodes that distill conversation into stored memories
- Integration with external memory layers (Mem0, Zep) for automatic extraction

**Retrieval/Injection:**

Cross-thread memory supports flexible namespacing (user, organization, context), JSON document storage, and content-based filtering. Semantic search is available when backed by pgvector or similar.

**Scoping:** Namespace-based. Developers define custom namespace hierarchies (e.g., `["user_123", "preferences"]` or `["org", "team_a", "patterns"]`).

**Quality Control:** No built-in contradiction handling or confidence scoring. This is left to the application layer or external memory services.

**What Works Well:**
- Reducer-driven state design prevents race conditions in parallel execution
- Checkpointing enables time-travel debugging
- Backend-agnostic BaseStore interface allows swapping storage without code changes
- Strong ecosystem with Redis, MongoDB, PostgreSQL integrations

**What Does Not Work Well:**
- No automatic learning extraction -- must be custom-built
- No built-in contradiction resolution
- Neither checkpointers nor Store API alone provide "true long-term memory" (semantic extraction, knowledge building)
- Steep learning curve for the graph programming model

**Key Design Decisions:**
- State-machine paradigm over chain-based (linear) execution
- Separation of thread-scoped state from cross-thread persistent memory
- Pluggable storage backends via abstract BaseStore interface

---

### 2.2 CrewAI

**Overview:** CrewAI is a multi-agent orchestration framework focused on collaborative AI teams. It provides one of the most opinionated built-in memory systems among agent frameworks.

**Memory Architecture:**

CrewAI implements four memory types unified under a single `Memory` class:

1. **Short-Term Memory:** Working memory scoped to a single `kickoff()` execution. Uses ChromaDB with RAG for retrieval. Acts as the scratchpad keeping agents coherent within a single run.

2. **Long-Term Memory:** Stores task results and knowledge across sessions using SQLite3. Structured, outcome-oriented storage designed for operational learning across runs. Records what worked and what did not.

3. **Entity Memory:** Uses RAG (ChromaDB) to capture and recall details about entities -- people, places, concepts, products. Extracted from conversations and task outputs.

4. **Procedural Memory (User-Defined):** Stores successful procedures and workflows that agents can reference for similar future tasks.

**How Learnings Are Extracted:**

CrewAI uses an LLM to analyze content when saving. When scope, categories, or importance are omitted, the LLM:
- Infers appropriate scope (agent, crew, global)
- Suggests categories and metadata (entities, dates, topics)
- Assigns importance scores
- Extracts entities automatically

This is a hybrid approach: the framework triggers extraction automatically at task boundaries, and the LLM does the semantic analysis.

**Storage Infrastructure:**

ChromaDB is the default vector storage backend. It provides:
- Persistent storage in `chroma.sqlite3`
- Concurrent access control with lock files
- Vector embeddings for semantic retrieval
- Configurable embedding models

Long-term memory uses a separate SQLite3 database for structured task outcomes.

**Retrieval/Injection:** Composite scoring blends semantic similarity, recency, and importance. Adaptive-depth recall adjusts how many memories are injected based on task complexity.

**Scoping:** Agent-level, crew-level (team), and global scope. The LLM auto-classifies scope when not explicitly set.

**Quality Control:** Importance scoring via LLM. No explicit contradiction handling -- newer memories can coexist with older conflicting ones. No temporal awareness.

**What Works Well:**
- Opinionated defaults reduce boilerplate -- memory works out of the box
- LLM-powered auto-classification of scope and importance
- Entity memory provides structured knowledge accumulation
- Composite scoring (similarity + recency + importance) is effective

**What Does Not Work Well:**
- ChromaDB is not suitable for large-scale production (no horizontal scaling)
- No contradiction detection or resolution
- Long-term memory stores raw task outcomes, not distilled knowledge
- No temporal awareness -- old facts persist alongside new ones
- Entity memory can accumulate noise without pruning

**Key Design Decisions:**
- Unified Memory class over separate subsystems
- LLM-in-the-loop for memory classification (adds latency but improves quality)
- ChromaDB as default trades scalability for simplicity
- Task boundaries as natural extraction points

---

### 2.3 Microsoft AutoGen

**Overview:** AutoGen is Microsoft's framework for building multi-agent conversational systems. Version 0.4 (January 2025) introduced a modular architecture with pluggable memory components.

**Memory Architecture:**

AutoGen 0.4 includes memory modules to manage:
- **Chat History:** Full conversation buffer with configurable window sizes
- **Summarization Memory:** LLM-generated summaries of long conversations
- **RAG Memory:** Vector-store-backed retrieval for external knowledge

However, AutoGen's memory is primarily session-scoped. Context is stored in memory during runtime -- once the process ends, the conversation is lost unless manually serialized.

**How Learnings Are Extracted:**

AutoGen does not automatically extract learnings. It provides:
- Serialization/deserialization of conversations for persistence
- Hooks for custom memory modules
- Integration points for external memory services

Developers must implement their own extraction logic or integrate with Mem0/Zep.

**Cross-Session Persistence:**

AutoGen supports serializing conversation state to enable persistent multi-session agents, but this is manual. The newer Microsoft Agent Framework (converging AutoGen + Semantic Kernel) adds more robust session management.

**Scoping:** Per-agent conversation scope. No built-in cross-agent or organizational memory.

**Quality Control:** None built-in. Relies on external services.

**What Works Well:**
- Flexible multi-agent conversation patterns (group chat, hierarchical)
- Modular memory components are easily swappable
- Strong integration with Azure ecosystem

**What Does Not Work Well:**
- No automatic learning extraction
- Memory is volatile by default
- No cross-agent memory sharing
- Being superseded by Microsoft Agent Framework (target GA: Q1 2026)

**Key Design Decisions:**
- Conversation-centric memory (optimized for chat, not task learning)
- Manual persistence by design (keeps the framework lightweight)
- Modular plugins over built-in intelligence

---

### 2.4 Microsoft Semantic Kernel / Agent Framework

**Overview:** Semantic Kernel is Microsoft's enterprise-grade AI orchestration framework, now converging with AutoGen into the unified Microsoft Agent Framework (target GA: end of Q1 2026).

**Memory Architecture:**

The memory system has three layers:

1. **Vector Store Connectors:** GA-released memory packages for .NET, Java, and Python. Supports Azure AI Search, Qdrant, Pinecone, Redis, PostgreSQL+pgvector, and in-memory stores. These enable RAG-based context retrieval.

2. **Semantic Memory Plugins:** Vector stores exposed as Semantic Kernel plugins. The AI model can invoke these plugins via function calling to search for relevant context, or they can be injected directly from prompt templates.

3. **Orchestration Memory:** In the Agent Framework, a central shared memory tracks the state of ongoing workflows, ensuring consistency across agents while allowing each to specialize.

**How Learnings Are Extracted:**

Semantic Kernel does not extract learnings automatically. It provides the infrastructure (vector stores, plugins) for developers to build extraction pipelines. The Agent Framework adds session-based state management that can persist chat summaries, user preferences, and task outcomes.

**Retrieval/Injection:**

Two modes:
- **Direct invocation:** Prompt templates include memory search calls
- **Function calling:** The AI model autonomously decides when to search memory

Both use semantic similarity over vector embeddings.

**Scoping:** Agent-level vector stores plus shared Orchestration Memory. Enterprise features include middleware and telemetry for memory access auditing.

**Quality Control:** No built-in contradiction handling. Relies on vector similarity scoring for relevance ranking.

**What Works Well:**
- Enterprise-grade with strong Azure integration
- Broad vector store connector ecosystem
- Plugin architecture makes memory searchable by the AI model itself
- Graph-based workflows for explicit multi-agent orchestration

**What Does Not Work Well:**
- No automatic fact extraction or learning
- No contradiction resolution
- Complex setup for simple use cases
- Framework is in transition (SK -> Agent Framework), creating migration overhead

**Key Design Decisions:**
- Plugin-based architecture (memory is just another plugin)
- Vector store agnostic via connector abstraction
- Enterprise-first: middleware, telemetry, type safety

---

### 2.5 OpenAI Assistants API & Agents SDK

**Overview:** OpenAI provides two systems: the Assistants API (being deprecated, target sunset H1 2026) and the newer Agents SDK with the Responses API.

**Assistants API Memory:**

1. **Thread Memory:** Threads store every message sent and received, automatically providing the assistant with full conversation history. The API handles truncation when conversations exceed context limits.

2. **File Search:** Files are added to vector stores for semantic retrieval. The assistant searches and retrieves relevant excerpts using similarity matching. Priced at $0.10/GB/day for vector store storage.

3. **Persistence:** Data is stored indefinitely until manually deleted. No cross-thread memory -- each thread is independent.

**Agents SDK Memory:**

The newer Agents SDK provides:

1. **Sessions:** A persistent memory layer for maintaining working context within an agent loop. Backends include SQLite (default in-memory, or file-backed), AsyncSQLiteSession (shared across workers), and SQLAlchemySession (production-grade with any SQL database).

2. **No Built-in Long-Term Memory:** The SDK handles short-term session history but does not provide durable or semantic memory. External solutions (Mem0, Zep) are required for cross-session persistence.

3. **Context Engineering Patterns:** OpenAI's recommended approach for personalization uses structured state -- preferences, constraints, prior outcomes -- injected as relevant slices into the agent context. They advocate "belief updates instead of fact accumulation" and "deterministic decision-making without relying on fragile semantic search."

**How Learnings Are Extracted:** No automatic extraction in either system.

**Quality Control:** None built-in. OpenAI's recommended pattern is structured state management (explicit fields) over unstructured memory accumulation.

**What Works Well:**
- Thread memory is zero-configuration
- File search with vector stores is production-grade
- Agents SDK session backends are pluggable and production-ready
- OpenAI's "structured state over semantic search" guidance is pragmatic

**What Does Not Work Well:**
- No cross-thread/cross-session memory
- No learning extraction
- Assistants API being deprecated creates migration burden
- File search costs accumulate at scale

**Key Design Decisions:**
- Stateless by default (session memory is opt-in)
- Structured state preferred over semantic memory for reliability
- Vector search for documents, not for learned facts

---

### 2.6 Cognition (Devin)

**Overview:** Devin is Cognition's autonomous AI software engineer. It operates inside a sandboxed environment with shell, editor, and browser, carrying out multi-step engineering tasks.

**Memory Architecture:**

Devin's learning system has three components:

1. **Playbooks:** Custom system prompts for recurring tasks. Like programs without rigid syntax -- they specify steps, success criteria, and guardrails. Used for complex work like database migrations, API integrations, and data pipeline ingestion. Teams create Playbooks when they find themselves repeating instructions.

2. **Knowledge:** General organizational context relevant across all runs. Teams share documentation, tips, internal library docs, and other materials. Devin uses Knowledge automatically to improve performance on all tasks.

3. **DeepWiki (Codebase Indexing):** Devin automatically indexes all repositories every couple of hours, creating detailed wikis with architecture diagrams, source links, and summaries. Works on massive codebases (5M lines of COBOL, 500GB repos). Powers "Devin Search" for codebase Q&A.

**How Learnings Are Extracted:**

- **Playbooks:** Manually authored by engineers based on observed patterns
- **Knowledge:** Manually curated documentation
- **DeepWiki:** Automatically generated and continuously updated via periodic indexing
- **Mistake Lists:** Cognition maintains a list of common mistakes committed to the codebase, with an agent that checks every PR against this list

Devin does NOT maintain long-term memory across sessions as of mid-2025. Context is bounded by what can be loaded into the context window during a given session.

**Retrieval/Injection:** DeepWiki provides semantic search over codebase documentation. Playbooks and Knowledge are injected based on task relevance.

**Scoping:** Organization-level (Knowledge), task-level (Playbooks), repository-level (DeepWiki).

**Quality Control:** Human-curated Playbooks and Knowledge ensure quality. DeepWiki is regenerated periodically, which prevents stale documentation.

**What Works Well:**
- Playbook pattern is highly effective for recurring tasks
- DeepWiki provides excellent codebase understanding
- Mistake-list pattern (check every PR against known mistakes) is simple and effective
- Separating Knowledge (general) from Playbooks (task-specific) is a clean abstraction

**What Does Not Work Well:**
- No cross-session memory (learning does not persist between tasks)
- Playbooks require manual creation and maintenance
- No automatic extraction of learnings from completed tasks
- "Senior-level at codebase understanding but junior at execution"

**Key Design Decisions:**
- Human-curated knowledge over automatic extraction (quality over quantity)
- Periodic re-indexing over incremental updates for codebase understanding
- Sandboxed execution environment for safety
- Compound AI system (Planner + Coder + Critic) rather than single model

---

### 2.7 Cosine (Genie)

**Overview:** Cosine's Genie is an AI software engineer that scores 30% on SWE-Bench (significantly outperforming earlier agents). Genie 2 is their proprietary model trained specifically for complex coding tasks.

**Memory Architecture:**

Limited public documentation on Cosine's internal memory system. What is known:

1. **Codebase Indexing:** Cosine indexes codebases for semantic understanding, mapping file relationships and functions. This creates a structured representation of the repository.

2. **Training Data as Memory:** Cosine spent nearly a year curating a dataset of real software development activities from actual engineers. The model itself encodes patterns from this training data.

3. **Multi-Agent Decomposition:** Genie Multi-agent decomposes backlog items into subtasks and coordinates execution. State is maintained across subtasks within a session.

**How Learnings Are Extracted:** Not publicly documented. The model appears to encode repository-specific patterns through indexing rather than runtime learning.

**What Works Well:**
- Strong benchmark performance suggests effective codebase representation
- CLI-based execution in actual development environments (not sandboxed)
- Multi-agent decomposition for complex tasks

**What Does Not Work Well:**
- Limited public documentation on memory architecture
- No evidence of cross-session learning
- Repository understanding appears to be index-based, not learned

---

### 2.8 Workflow Engines: Windmill, n8n, Temporal

**Overview:** These are workflow orchestration platforms that have added AI agent capabilities. They approach memory from an infrastructure perspective rather than an AI-native one.

**Windmill:**
- Fast, open-source workflow engine for internal tools
- AI workflow orchestration emerged as a primary use case in 2025-2026
- No built-in agent memory -- coordinates LLM calls as workflow steps
- State persists in workflow execution context (variables, databases)
- Best for low-frequency scripts and internal tools with AI augmentation

**n8n:**
- Open-source workflow automation with drag-and-drop UI
- Added AI Agent node powered by LangChain for reasoning and tool use
- **Memory via PostgreSQL:** Conversation history persists in SQL tables that survive restarts and scaling
- Supports memory nodes for maintaining context across interactions
- 70%+ of users struggle with context retention according to 2025 industry reports
- Best for external integrations with AI agent augmentation

**Temporal:**
- Code-driven, production-grade distributed workflow orchestration
- No AI-specific memory -- provides strong consistency, retries, fault tolerance
- Workflow state is durable by design (survives crashes, restarts)
- Activities can read/write to external stores for agent memory
- Best for high-concurrency, long-running workflows that need guaranteed completion

**Key Insight:** Workflow engines provide the execution infrastructure (durability, retries, state persistence) but not the intelligence layer (extraction, semantic search, contradiction handling). They are complementary to, not replacements for, dedicated memory systems.

---

### 2.9 NVIDIA Voyager

**Overview:** Voyager is the first LLM-powered embodied lifelong learning agent, demonstrated in Minecraft. Published by NVIDIA/MineDojo in 2023, it remains one of the most influential architectures for agent skill learning.

**Memory Architecture -- Skill Library:**

Voyager's core innovation is an ever-growing skill library of executable code:

1. **Skill as Code:** Each learned skill is a JavaScript function with a descriptive docstring. Skills are stored as code, not as natural language descriptions.

2. **Vector-Indexed Retrieval:** Successful programs are stored in a vector database, indexed by the embedding of their docstring. When a new task is encountered, the most relevant skills are retrieved by semantic similarity.

3. **Compositional Skills:** Complex skills are synthesized by composing simpler skills. This compounding effect accelerates capability growth and prevents catastrophic forgetting.

**Three Key Components:**

1. **Automatic Curriculum:** Maximizes exploration by generating increasingly challenging objectives
2. **Skill Library:** Stores and retrieves executable code for complex behaviors
3. **Iterative Prompting:** Incorporates environment feedback, execution errors, and self-verification for program improvement

**How Learnings Are Extracted:**

- Agent generates code to accomplish a task
- Code is executed in the environment
- If successful (verified by self-verification module), the code is stored as a skill
- Failed attempts trigger iterative refinement using environment feedback
- Only verified successful skills enter the library

**Quality Control:**
- Self-verification before storage (the agent checks its own work)
- Only successful programs are stored
- Compositional structure means higher-level skills implicitly validate lower-level ones

**Performance:** 3.3x more unique items, 2.3x longer distances, up to 15.3x faster milestone unlocking compared to prior state-of-the-art. Learned skills transfer to new Minecraft worlds.

**What Works Well:**
- Executable code as memory format ensures reliability (it either works or it does not)
- Self-verification prevents bad skills from polluting the library
- Compositional structure enables compounding capability growth
- Vector indexing enables efficient retrieval of relevant skills

**What Does Not Work Well:**
- Requires a verifiable environment (code execution with observable outcomes)
- No mechanism for updating or deprecating skills
- Skills are Minecraft-specific -- architecture needs adaptation for other domains
- No explicit contradiction handling (relies on verification)

**Key Design Decisions:**
- Code over natural language for skill representation
- Verification before storage (quality gate)
- Vector similarity for retrieval
- No weight updates -- all learning happens in the skill library

**Relevance to FlowForge:** The Voyager pattern of "verified executable procedures as memory" maps directly to agent playbooks and procedures. The self-verification pattern (agent checks its own output before storing as a learning) is applicable to FlowForge's memory extraction.

---

### 2.10 Reflexion / Self-Refine

**Overview:** Reflexion (Shinn et al., 2023) is an academic framework for "verbal reinforcement learning" -- agents improve through natural language self-reflection rather than weight updates.

**Memory Architecture:**

Two-component memory system:

1. **Short-Term Memory:** The trajectory of the current attempt -- observations, actions, and outcomes within a single trial.

2. **Long-Term Memory:** Stored reflections -- distilled, natural language summaries of what went wrong and what to do differently. These persist across trials and are injected into future attempts.

**Learning Loop:**

```
1. Define task
2. Generate trajectory (attempt the task)
3. Evaluate (binary or scalar reward signal)
4. Self-reflect (generate verbal reinforcement cue)
5. Store reflection in long-term memory
6. Generate next trajectory (with reflections injected)
7. Repeat until success or max trials
```

**How Learnings Are Extracted:**

The Self-Reflection model generates verbal reinforcement cues using:
- The reward signal (success/failure)
- The current trajectory (what happened)
- Persistent memory (past reflections)

This produces specific, actionable feedback like "I should have checked for null values before accessing the array" rather than vague assessments.

**Quality Control:**
- Reflections are generated only after evaluation (grounded in actual outcomes)
- The evaluator provides an external quality signal
- Reflections are appended, not replaced -- building a cumulative knowledge base

**Performance:** 91% pass@1 on HumanEval (vs. 80% for GPT-4 without reflection). Significant improvements on AlfWorld decision-making and HotPotQA reasoning.

**What Works Well:**
- Verbal reinforcement is more efficient than weight updates
- Reflections are human-readable and auditable
- Cumulative reflection memory provides compounding improvement
- No model fine-tuning required

**What Does Not Work Well:**
- Requires multiple trial-and-error attempts per task (latency cost)
- Reflections can accumulate and exceed context windows
- No mechanism for pruning outdated reflections
- Evaluator quality determines reflection quality

**Key Design Decisions:**
- Natural language reflections over numerical rewards
- Cumulative memory (append-only) over summarization
- External evaluator over self-evaluation for the reward signal
- Episode-based learning (per-task) over continuous learning

**Relevance to FlowForge:** Reflexion's pattern maps closely to FlowForge's current `<agent_learnings>` extraction. The key insight is that reflections should be grounded in actual execution outcomes (success/failure), not just self-assessment. Adding an evaluator step before extracting learnings would improve quality.

---

### 2.11 MemGPT / Letta

**Overview:** MemGPT (now Letta) is the pioneering system for treating LLM context management as an operating system problem. It uses virtual context management to provide the illusion of unlimited memory within fixed context windows.

**Memory Architecture -- Three Tiers:**

1. **Core Memory (In-Context, "RAM"):**
   - Memory blocks pinned to the agent's context window
   - Editable by the agent itself via tool calls (`core_memory_append`, `core_memory_replace`)
   - Organized as labeled sections (e.g., "human", "persona", "task")
   - Each block has a character limit (default 2K)
   - Always visible to the agent -- no retrieval needed

2. **Recall Memory ("Conversation Log"):**
   - Complete history of all interactions
   - Automatically saved to disk
   - Searchable via `conversation_search` and `conversation_search_date` tools
   - Not in context by default -- must be explicitly retrieved

3. **Archival Memory ("Disk Storage"):**
   - Explicitly formulated knowledge in external databases
   - Can use vector databases, graph databases, or other formats
   - Retrieved via `archival_memory_search` tool
   - Contains processed, indexed information (not raw conversation)
   - Insertable via `archival_memory_insert` tool

**How Learnings Are Extracted:**

The agent manages its own memory. This is the key architectural decision:
- The agent has tools to read, write, search, and modify all three memory tiers
- The agent decides what to remember, what to forget, and what to promote from recall to archival
- The system prompt instructs the agent to maintain its memory proactively

This is "self-managed memory" -- no external extraction pipeline.

**Retrieval/Injection:**
- Core memory is always injected (it is the context)
- Recall and archival memory are searched on-demand via tool calls
- The agent decides when to search (function calling)

**Quality Control:**
- Agent-driven curation (the agent prunes and updates its own memory)
- Character limits on core memory force prioritization
- No external validation or contradiction detection

**What Works Well:**
- The OS metaphor is intuitive and powerful
- Agent-managed memory is self-correcting (the agent can fix its own errors)
- Three-tier hierarchy naturally maps to different access patterns
- Works within fixed context windows without special infrastructure

**What Does Not Work Well:**
- Relies on the agent's judgment for memory quality (can be unreliable)
- No external validation of stored memories
- Memory management consumes tokens (tool calls for every read/write)
- Core memory character limits are restrictive for complex domains
- No built-in multi-agent memory sharing

**Key Design Decisions:**
- Agent as memory manager (not an external service)
- OS-inspired tiered architecture (RAM/disk analogy)
- Tool-based memory access (standard function calling)
- In-context vs. out-of-context as the fundamental distinction

**Relevance to FlowForge:** Letta's three-tier model (core/recall/archival) maps well to FlowForge's needs. The "agent manages its own memory" approach is what FlowForge's `<agent_learnings>` pattern does. The key lesson is that this should be complemented by an external extraction pipeline (like Mem0) for higher-quality learning capture.

---

### 2.12 Mem0

**Overview:** Mem0 is a dedicated memory layer for AI agents, designed for production deployments. It has emerged as the de facto standard for adding memory to agent frameworks, with integrations across LangGraph, CrewAI, OpenAI Agents SDK, and others.

**Memory Architecture:**

Mem0 uses a dual-store approach:

1. **Vector Memory:** Facts extracted from conversations, stored as embeddings for semantic retrieval. Each memory is a self-contained proposition.

2. **Graph Memory (Mem0g):** A knowledge graph that captures relationships between entities. Nodes are entities, edges are relationships. Temporal metadata tracks when facts were established and invalidated.

**The Four Operations (Core Innovation):**

When new information arrives, an LLM determines which operation to execute:

| Operation | When Used | Effect |
|-----------|-----------|--------|
| **ADD** | No semantically equivalent memory exists | Creates new memory entry |
| **UPDATE** | Existing memory can be augmented with complementary info | Enriches existing entry |
| **DELETE** | New information contradicts existing memory | Removes outdated entry |
| **NOOP** | New information adds no value (duplicate, noise) | No action taken |

This is the most mature contradiction-handling system in production. When a user says they moved from Mumbai to Bangalore, Mem0 deletes the old city fact and adds the new one.

**How Learnings Are Extracted:**

Automatic LLM-based extraction pipeline:
1. New conversation or event arrives
2. LLM extracts candidate facts
3. Each fact is compared against existing memories (semantic similarity)
4. LLM classifies the operation (ADD/UPDATE/DELETE/NOOP)
5. Operation is executed atomically
6. Graph memory updates entity relationships

**Retrieval/Injection:**

- Semantic search over vector store for relevant facts
- Graph traversal for relationship queries
- Combined scoring: semantic similarity + recency + importance
- Actor-aware filtering in multi-agent scenarios (who said what)

**Scoping:**

- **User-level:** Individual user preferences and history
- **Agent-level:** Agent-specific learnings
- **Session-level:** Current conversation context
- **Organization-level:** Shared knowledge across all agents

Project-level configuration (v1.0.3, January 2026) allows tuning:
- Inclusion/exclusion prompts for extraction focus
- Memory depth settings
- Use-case-specific extraction rules

**Quality Control:**

- NOOP operation prevents noise accumulation ("saving everything is not intelligence")
- DELETE operation resolves contradictions
- UPDATE enriches rather than duplicates
- Actor-aware tagging prevents one agent's inference from becoming another agent's ground truth
- Configurable extraction focus (inclusion/exclusion prompts)

**Performance:** 26% relative improvement in LLM-as-a-Judge metrics over baseline, 91% lower p95 latency, 90%+ token cost savings compared to full-context approaches.

**Production Adoption:**
- AWS partnership as supported memory layer
- Apache Cassandra support for high-throughput deployments
- Valkey support for distributed storage
- FastEmbed for on-device embeddings (privacy-sensitive deployments)

**What Works Well:**
- ADD/UPDATE/DELETE/NOOP is the gold standard for contradiction handling
- Graph memory captures entity relationships that vector-only approaches miss
- Actor-aware tagging prevents multi-agent confusion
- Production-proven at scale
- Framework-agnostic (integrates with everything)

**What Does Not Work Well:**
- External service dependency (adds latency to every interaction)
- LLM-in-the-loop extraction adds cost per interaction
- Graph memory can grow unbounded without explicit pruning strategies
- Extraction quality depends heavily on the LLM used

**Key Design Decisions:**
- Four-operation model (ADD/UPDATE/DELETE/NOOP) over append-only
- Dual store (vector + graph) over vector-only
- LLM-in-the-loop extraction over rule-based
- Framework-agnostic layer over framework-specific module
- Actor-aware tagging for multi-agent scenarios

**Relevance to FlowForge:** Mem0's ADD/UPDATE/DELETE/NOOP model is the single most important pattern for FlowForge to adopt. The current system's `supersede` operation is a manual version of this -- making it automatic with LLM classification would significantly improve memory quality. The actor-aware tagging is also relevant for FlowForge's multi-agent scenarios.

---

### 2.13 Zep (Graphiti)

**Overview:** Zep is a memory layer service built around Graphiti, a temporally-aware knowledge graph engine. It focuses on capturing the temporal dimension of agent memory -- facts change over time, and the graph tracks this evolution.

**Memory Architecture -- Temporal Knowledge Graph:**

The knowledge graph G = (N, E, phi) comprises three hierarchical tiers:

1. **Episode Subgraph:** Raw conversation episodes with timestamps. The ground truth of what was said and when.

2. **Semantic Entity Subgraph:** Extracted entities (people, places, concepts) with typed relationships. Each entity and relationship has temporal metadata (valid_from, valid_to, invalidated_at).

3. **Community Subgraph:** Higher-level clusters of related entities and patterns. Used for summarization and trend detection.

**How Learnings Are Extracted:**

Two-phase extraction during episode ingestion:

1. **Entity Extraction:** Processes current message plus last n messages (n=4, providing two complete conversation turns for context). Uses NER to identify entities.

2. **Fact Extraction:** Uses the episodic context and previously extracted entities to extract facts as relationships between entity pairs. Each fact is a self-contained, context-free proposition (an atomic unit of information).

**Temporal Awareness:**

This is Zep's key differentiator. Every node and edge has:
- `created_at`: When the fact was first observed
- `valid_at`: When the fact became true
- `invalid_at`: When the fact was superseded or invalidated
- `expired_at`: When the fact was removed from active consideration

This enables queries like "what did we know about this product group as of last Tuesday?" -- critical for debugging agent decisions.

**Retrieval:** Combines graph traversal with semantic search. Supports temporal queries (facts valid at a specific point in time).

**Quality Control:**
- Temporal invalidation over deletion (audit trail preserved)
- Fact deduplication via semantic similarity
- Community detection for pattern identification
- Episodic grounding (all facts trace back to source episodes)

**What Works Well:**
- Temporal awareness is unmatched -- no other system tracks fact validity windows
- Graph structure captures relationships that flat memory misses
- Audit trail via temporal metadata enables debugging
- Outperforms MemGPT on Deep Memory Retrieval benchmark

**What Does Not Work Well:**
- Graph databases add infrastructure complexity
- Extraction pipeline is more expensive than vector-only approaches
- Community detection requires sufficient data density
- Neo4j dependency can be a deployment constraint

**Key Design Decisions:**
- Graph over vector as primary storage (relationships matter more than similarity)
- Temporal metadata on all entities and facts
- Invalidation over deletion (never lose history)
- Episode -> Entity -> Community hierarchy for progressive abstraction

**Relevance to FlowForge:** Zep's temporal awareness is directly relevant to FlowForge's pipeline debugging use case. When investigating why an agent made a bad decision, temporal queries ("what did the agent know at that point?") are invaluable. The invalidation-over-deletion pattern preserves audit trails that FlowForge's `supersede` operation partially implements.

---

### 2.14 Amazon Bedrock AgentCore Memory

**Overview:** Amazon Bedrock AgentCore provides a managed memory service for AI agents within the AWS ecosystem, offering both short-term and long-term memory with multiple extraction strategies.

**Memory Architecture:**

1. **Short-Term Memory:** Raw interaction storage for maintaining context within a single session.

2. **Long-Term Memory:** Persistent insights and preferences across sessions, with three built-in extraction strategies:

| Strategy | ID | Purpose |
|----------|-----|---------|
| **Semantic Memory** | `semantic-facts` | Extracts factual information and contextual knowledge. Builds a persistent knowledge base about entities, events, and details. |
| **Summary Memory** | `conversation-summary` | Generates summaries of conversations for efficient context recall without re-processing full history. |
| **User Preference** | `user-preferences` | Extracts and tracks user preferences, constraints, and stated requirements. |

3. **Custom Strategies:** Developers can specify a custom LLM and override the extraction and consolidation prompts for domain-specific use cases.

**How Learnings Are Extracted:**

Each strategy uses an LLM to process conversation data:
- **Extraction prompt:** Identifies relevant facts/summaries/preferences from new interactions
- **Consolidation prompt:** Merges new extractions with existing memory, handling updates and contradictions

Custom strategies allow full control over both prompts.

**Retrieval/Injection:** Semantic search over extracted memories. Integrated directly into the Foundry runtime where agents can store and retrieve within the same execution context.

**Scoping:** Session-level and cross-session. Integration with AWS IAM for access control.

**Quality Control:** Strategy-specific consolidation handles contradictions. Custom prompts allow domain-specific quality rules.

**What Works Well:**
- Managed service eliminates infrastructure overhead
- Multiple extraction strategies for different memory types
- Custom strategies provide flexibility for domain-specific needs
- Deep AWS ecosystem integration

**What Does Not Work Well:**
- AWS lock-in
- Limited customization compared to self-hosted solutions
- Relatively new (launched late 2025) -- less battle-tested
- No graph-based memory option

**Key Design Decisions:**
- Strategy-based extraction (multiple specialized extractors over one general one)
- Separation of extraction and consolidation prompts
- Managed service over self-hosted
- AWS-native integration over framework-agnostic

---

### 2.15 Claude Code

**Overview:** Anthropic's Claude Code is a CLI-based AI coding agent. Its memory system uses a file-based approach that is remarkably simple yet effective.

**Memory Architecture:**

Two distinct memory systems:

1. **CLAUDE.md (Human-Authored Instructions):**
   - Markdown files giving Claude persistent instructions
   - Loaded into context window at session start
   - Three levels: project-level (`.claude/CLAUDE.md`), user-level (`~/.claude/CLAUDE.md`), organization-level
   - Human-written, not auto-generated

2. **Auto Memory / MEMORY.md (Agent-Authored Learnings):**
   - Directory where Claude writes its own notes during sessions
   - Patterns discovered, project-specific behaviors, debugging insights
   - First 200 lines or 25KB of `MEMORY.md` loads automatically at session start
   - Claude writes to this file based on corrections and discoveries

3. **Auto Dream (Memory Consolidation):**
   - Reviews what Auto Memory has collected
   - Strengthens relevant entries, removes outdated ones
   - Reorganizes into clean, indexed topic files
   - Acts as a garbage-collection / defragmentation process for memory

**How Learnings Are Extracted:**

- **Implicit:** When a user corrects Claude, it can store the correction as a memory entry
- **Explicit:** Claude can proactively write observations to MEMORY.md
- **Consolidation:** Auto Dream periodically reviews and cleans up accumulated memories

**Retrieval/Injection:**
- File-based injection at session start (first 200 lines / 25KB)
- No semantic search -- the entire memory block is injected
- Priority: CLAUDE.md (instructions) takes precedence over MEMORY.md (learnings)

**Scoping:**
- Project-level: `.claude/CLAUDE.md` and per-project MEMORY.md
- User-level: `~/.claude/CLAUDE.md`
- Organization-level: shared CLAUDE.md via version control

**Quality Control:**
- Auto Dream consolidation removes outdated entries
- 200-line / 25KB limit forces prioritization
- Human review via version control (CLAUDE.md is committed to git)
- No automatic contradiction detection

**What Works Well:**
- Extreme simplicity -- just markdown files
- Version-controllable (CLAUDE.md in git)
- Separation of human instructions (CLAUDE.md) from agent learnings (MEMORY.md)
- Auto Dream provides periodic cleanup
- Zero infrastructure required

**What Does Not Work Well:**
- No semantic search (entire block injected, wasting tokens on irrelevant memories)
- 200-line limit is restrictive for complex projects
- No structured extraction (free-form markdown)
- No cross-project memory sharing
- No temporal awareness

**Key Design Decisions:**
- Files over databases (simplicity, version control, transparency)
- Full injection over selective retrieval (simpler but less efficient)
- Separation of human-authored (CLAUDE.md) from agent-authored (MEMORY.md)
- Periodic consolidation (Auto Dream) over real-time pruning

**Relevance to FlowForge:** The CLAUDE.md / MEMORY.md separation mirrors FlowForge's distinction between agent instructions and agent memory. The Auto Dream consolidation pattern is relevant -- FlowForge should consider periodic memory consolidation to prevent noise accumulation. The 200-line injection limit is a practical lesson: at some point, injecting everything becomes wasteful and selective retrieval is needed.

---

### 2.16 Cursor AI

**Overview:** Cursor is an AI-powered IDE that uses RAG over the full project structure for context management.

**Memory Architecture:**

1. **Codebase Indexing:** RAG-based understanding of entire project structure. Uses embedding search, importance ranking, and smart truncation to fit context into token budgets.

2. **Session Persistence:** Composer 2 maintains persistent context across entire development sessions -- remembering decisions, constraints, and specifications from earlier in the conversation.

3. **Multi-Agent Context:** 8 parallel agents execute different tasks simultaneously, with a shared context model ensuring coherence across parallel changes.

**How Learnings Are Extracted:** No explicit learning extraction. Context is recomputed via RAG on each interaction. Session memory is volatile.

**What Works Well:**
- RAG over codebase provides excellent contextual relevance
- Smart truncation with importance ranking optimizes token usage
- Parallel agents with shared context enable complex refactoring

**What Does Not Work Well:**
- No persistent learning across sessions
- Memory leaks during extended sessions (being addressed in v2.0)
- RAG quality depends heavily on embedding model and ranking

---

## 3. Comparative Analysis Table

| System | Memory Tiers | Extraction Method | Storage Backend | Contradiction Handling | Scoping | Cross-Session | Production-Ready |
|--------|-------------|-------------------|-----------------|----------------------|---------|---------------|-----------------|
| **LangGraph** | 2 (state + store) | Manual / custom nodes | Pluggable (PG, Redis, Mongo, SQLite) | None built-in | Namespace-based | Yes (BaseStore) | Yes |
| **CrewAI** | 4 (short/long/entity/procedural) | LLM auto-classification | ChromaDB + SQLite | None | Agent/crew/global | Yes (SQLite) | Partial (ChromaDB limits) |
| **AutoGen** | 1 (conversation buffer) | Manual serialization | In-memory (volatile) | None | Per-agent | Manual only | No (being replaced) |
| **Semantic Kernel** | 2 (vector store + orchestration) | Manual / plugin-based | Azure AI Search, Qdrant, Pinecone, etc. | None built-in | Agent + shared orchestration | Via vector store | Yes (enterprise) |
| **OpenAI Assistants** | 2 (thread + file search) | None | OpenAI-managed | None | Per-thread | No | Yes (but sunsetting) |
| **OpenAI Agents SDK** | 1 (session) | None | SQLite, SQLAlchemy | None | Per-session | Via external service | Yes |
| **Devin** | 3 (playbook/knowledge/DeepWiki) | Manual + periodic indexing | Proprietary | N/A (human-curated) | Org/task/repo | No (session-scoped) | Yes |
| **Cosine (Genie)** | 1 (codebase index) | Codebase indexing | Proprietary | N/A | Per-repo | No | Yes |
| **n8n** | 1 (PostgreSQL chat history) | None | PostgreSQL | None | Per-workflow | Yes | Partial |
| **Temporal** | 0 (workflow state only) | N/A | Workflow state store | N/A | Per-workflow | Via activities | Yes (infra only) |
| **Voyager** | 1 (skill library) | Self-verification + storage | Vector DB (code) | Verification gate | Global | Yes | Research only |
| **Reflexion** | 2 (trajectory + reflections) | Self-reflection after evaluation | In-memory | Append-only | Per-task | No | Research only |
| **MemGPT / Letta** | 3 (core/recall/archival) | Agent self-managed | Configurable (PG, vector DBs) | Agent-driven curation | Per-agent | Yes | Yes |
| **Mem0** | 2 (vector + graph) | LLM extraction pipeline | Vector DB + Neo4j/custom | ADD/UPDATE/DELETE/NOOP | User/agent/session/org | Yes | Yes (production-proven) |
| **Zep (Graphiti)** | 3 (episode/entity/community) | Two-phase NER + fact extraction | Neo4j + vector store | Temporal invalidation | Per-user/agent | Yes | Yes |
| **Bedrock AgentCore** | 2 (short-term + long-term) | Strategy-based LLM extraction | AWS-managed | Strategy consolidation | Session + cross-session | Yes | Yes (managed service) |
| **Claude Code** | 2 (CLAUDE.md + MEMORY.md) | Implicit correction capture | Markdown files | Auto Dream consolidation | Project/user/org | Yes (file-based) | Yes |
| **Cursor** | 1 (RAG index + session) | None (RAG recompute) | In-memory + embeddings | N/A | Per-session | No | Yes |

---

## 4. Cross-Cutting Themes and Patterns

### 4.1 The Memory Extraction Spectrum

Systems fall on a spectrum from fully manual to fully automatic:

```
Manual                                                          Automatic
|----------|----------|----------|----------|----------|----------|
AutoGen    LangGraph  Devin      Letta      CrewAI     Mem0
OpenAI SDK SK         Claude     (self-     (LLM       Zep
                      Code       managed)   classify)  AgentCore
```

**Finding:** The most effective production systems use automatic LLM-based extraction (Mem0, Zep, AgentCore) but allow manual overrides. Purely self-managed systems (Letta) are elegant but unreliable at scale.

### 4.2 The Contradiction Problem

Three approaches to handling contradictory information:

1. **Append-Only (Reflexion, basic CrewAI):** Never delete, accumulate everything. Simple but degrades over time.
2. **Agent Self-Curation (Letta):** The agent manages its own memory. Elegant but inconsistent.
3. **Automated Classification (Mem0, Zep, AgentCore):** An LLM classifies each new fact against existing memory. Most reliable but most expensive.

**Finding:** Approach 3 is the industry direction. Mem0's ADD/UPDATE/DELETE/NOOP is the gold standard. Zep's temporal invalidation adds an audit trail dimension.

### 4.3 Storage Architecture Patterns

| Pattern | Used By | Best For |
|---------|---------|----------|
| **Vector-only** | LangGraph, CrewAI, OpenAI | Simple semantic retrieval, low infrastructure |
| **Graph-only** | Zep | Relationship-heavy domains, temporal queries |
| **Vector + Graph** | Mem0 | Comprehensive memory (facts + relationships) |
| **Structured DB** | CrewAI (SQLite), n8n (PG) | Task outcomes, structured data |
| **Files** | Claude Code, Devin | Simple projects, version-controllable |
| **Tiered (RAM/Disk)** | Letta | Context-window optimization |

**Finding:** The trend is toward dual-store (vector + graph) for production systems. Vector-only is sufficient for simple use cases but misses entity relationships. Files work surprisingly well for developer tools where version control is valued.

### 4.4 Scoping Patterns

All production multi-agent systems implement some form of scoping:

| Scope Level | Description | Used By |
|-------------|-------------|---------|
| **Agent** | Private to a single agent | All systems |
| **Team/Crew** | Shared within a team of agents | CrewAI, FlowForge |
| **User/Session** | Scoped to a user or conversation | Mem0, Bedrock, OpenAI |
| **Project/Repository** | Scoped to a codebase or project | Claude Code, Devin, Cursor |
| **Organization** | Global across all agents and users | Mem0, Claude Code, FlowForge |

**Finding:** FlowForge's existing three-tier scoping (agent/team/org) is well-aligned with industry practice. Adding a project/task scope would match Devin's Playbook pattern.

### 4.5 Retrieval Strategies

| Strategy | Description | Used By | Trade-off |
|----------|-------------|---------|-----------|
| **Full Injection** | Load all memories into context | Claude Code | Simple but wasteful |
| **Semantic Search** | Vector similarity over memories | LangGraph, Mem0, CrewAI | Flexible but can miss structured facts |
| **Graph Traversal** | Follow entity relationships | Zep, Mem0 | Captures relationships but complex |
| **Composite Scoring** | Blend similarity + recency + importance | CrewAI, FlowForge | Best overall but requires tuning |
| **Agent-Driven** | Agent decides when to search | Letta | Autonomous but unpredictable |

**Finding:** Composite scoring (FlowForge's current approach) is well-regarded. Adding graph-based retrieval for entity relationships would further improve precision.

### 4.6 The Quality Gate Pattern

Multiple systems implement a verification or quality check before storing learnings:

| System | Quality Gate |
|--------|-------------|
| Voyager | Self-verification (code execution) |
| Reflexion | External evaluator |
| Mem0 | NOOP classification (reject noise) |
| Devin | Human-curated Playbooks |
| Claude Code | Auto Dream consolidation |
| FlowForge | Confidence scoring + manual validation |

**Finding:** The most robust systems have two quality gates: one at extraction time (Mem0's NOOP) and one periodic (Claude Code's Auto Dream). FlowForge should implement both.

---

## 5. Recommendations for FlowForge

Based on the research findings, here are specific recommendations organized by priority.

### 5.1 High Priority -- Adopt Immediately

#### R1: Implement Automated Contradiction Handling (Mem0 Pattern)

**Current state:** FlowForge uses manual `supersede` operation for outdated memories.

**Recommendation:** Implement Mem0's four-operation model (ADD/UPDATE/DELETE/NOOP) as an automated pipeline:

```
New learning arrives
  -> LLM compares against existing memories (semantic similarity search)
  -> Classify operation: ADD | UPDATE | DELETE | NOOP
  -> Execute operation atomically
  -> Log the decision for audit
```

**Why:** This is the single highest-impact improvement. Without it, memory quality degrades over time as contradictory facts accumulate. Every production system that works at scale has some form of this.

**Implementation approach:**
- Add a `MemoryConsolidationService` that runs on every new learning extraction
- Use semantic similarity to find candidate conflicting memories
- Use an LLM call to classify the operation
- Preserve audit trail (who created, what was superseded, why)

#### R2: Add Periodic Memory Consolidation (Auto Dream Pattern)

**Current state:** No periodic cleanup of accumulated memories.

**Recommendation:** Implement a scheduled consolidation job (inspired by Claude Code's Auto Dream):

```
Consolidation Cron (weekly or configurable):
  1. Load all active memories for each scope (agent, team, org)
  2. Identify clusters of related memories
  3. Merge overlapping memories into consolidated entries
  4. Remove or archive entries that are no longer relevant
  5. Re-score importance based on usage patterns
  6. Generate a consolidation report
```

**Why:** Memory systems without periodic cleanup accumulate noise. Claude Code's Auto Dream and Mem0's NOOP both address this. A scheduled consolidation job is lower-risk than real-time cleanup.

#### R3: Add Dual Extraction Pipeline (Agent Self-Report + LLM Extraction)

**Current state:** FlowForge relies on agent self-reported `<agent_learnings>` tags.

**Recommendation:** Keep self-reported learnings but add a parallel LLM extraction pipeline:

```
Execution completes
  -> Path A: Parse <agent_learnings> tags (existing)
  -> Path B: LLM analyzes full execution output for implicit learnings
  -> Deduplicate across A and B
  -> Apply ADD/UPDATE/DELETE/NOOP classification
  -> Store
```

**Why:** Self-reported learnings miss implicit patterns. Agents often discover important information without explicitly flagging it. Amazon Bedrock AgentCore's strategy-based extraction and Mem0's automatic pipeline both demonstrate that external extraction catches learnings that self-reporting misses.

### 5.2 Medium Priority -- Implement Within 1-2 Quarters

#### R4: Add Temporal Metadata to All Memory Entries (Zep Pattern)

**Current state:** Memories have `createdAt`, `updatedAt`, and optional `expiresAt`.

**Recommendation:** Add Zep-inspired temporal fields:

```typescript
interface TemporalMemoryEntry extends AgentMemoryEntry {
  validFrom: Date;      // When this fact became true
  validUntil?: Date;    // When this fact was superseded (null = still valid)
  invalidatedBy?: string; // ID of the memory that replaced this one
  invalidationReason?: string; // Why it was superseded
  sourceExecutionId: string; // Which execution created this memory
}
```

**Why:** Temporal metadata enables debugging queries like "what did the agent know when it made this decision?" This is critical for investigating pipeline failures where agent decisions led to bad outcomes. Zep's temporal knowledge graph demonstrates the value of this approach.

#### R5: Add Skill/Procedure Memory Type (Voyager Pattern)

**Current state:** FlowForge has `procedure` as a memory type but does not verify procedures before storage.

**Recommendation:** Enhance procedure memory with Voyager's verification pattern:

```
Agent discovers a successful approach
  -> Extract as a procedure (step-by-step instructions)
  -> Tag with: category, vendor, pipeline_stage, success_count
  -> On future use: track success/failure
  -> Procedures with high failure rates are flagged for review
  -> Procedures compose: complex procedures reference simpler ones
```

**Why:** Voyager's key insight is that only verified successful skills should enter the library. FlowForge's current procedures are stored without verification. Adding execution tracking (was this procedure actually useful?) would enable natural quality ranking.

#### R6: Add Project/Task Scope (Devin Pattern)

**Current state:** Three scopes: agent, team, org.

**Recommendation:** Add two more scopes:

- **Category scope:** Memories specific to a product category (e.g., "laptops have complex variant axes"). Mapped to `category_id`.
- **Vendor scope:** Memories specific to a retailer (e.g., "BestBuy changed their DOM structure on 2026-03-15"). Already partially supported via `vendor` field but not used as a scoping mechanism.

**Why:** Devin's separation of Knowledge (general) from Playbooks (task-specific) demonstrates that different scopes serve different purposes. Pipeline agents working on laptop categories need different context than those working on cameras.

### 5.3 Lower Priority -- Strategic Investments

#### R7: Evaluate Graph Memory for Entity Relationships

**Current state:** Memory is stored as flat documents in MongoDB.

**Recommendation:** Evaluate adding a graph layer (similar to Mem0's graph memory or Zep's Graphiti) for capturing entity relationships:

- Brand -> has_series -> Series -> has_model -> Model
- Category -> uses_strategy -> GroupingStrategy
- Vendor -> changed_structure_on -> Date

**Why:** Flat memory misses relationships. When an agent needs to understand why a BestBuy scraping rule broke, it needs to traverse: BestBuy -> changed DOM on March 15 -> affects selectors X, Y, Z -> related to categories A, B. This is a graph query.

**Trade-off:** Graph infrastructure (Neo4j) adds complexity. This should only be pursued if the simpler improvements (R1-R6) prove insufficient.

#### R8: Implement Memory Importance Decay

**Current state:** Memories have static importance scores.

**Recommendation:** Implement time-based importance decay:

```
effective_score = base_score * decay_factor^(days_since_last_use)
```

Where `decay_factor` is configurable per memory type:
- `mistake`: Slow decay (0.99/day) -- mistakes remain relevant longer
- `domain_knowledge`: Very slow decay (0.995/day) -- facts persist
- `pattern`: Medium decay (0.98/day) -- patterns can become outdated
- `gotcha`: Slow decay (0.99/day) -- gotchas remain relevant

**Why:** Without decay, the memory store grows monotonically and retrieval quality degrades. Memories that have not been used in months should naturally fade in priority.

#### R9: Add Evaluator-Gated Learning (Reflexion Pattern)

**Current state:** Learnings are extracted from both successful and failed executions.

**Recommendation:** Add an evaluation step before learning extraction:

```
Execution completes
  -> Evaluator scores execution (success/partial/failure)
  -> If success: extract "pattern" and "procedure" learnings
  -> If failure: extract "mistake" and "gotcha" learnings
  -> Evaluation score attached to each learning as confidence modifier
```

**Why:** Reflexion demonstrates that grounding reflections in actual outcomes (not just self-assessment) produces higher-quality learnings. An agent that says "I learned X" but actually failed should have its learnings discounted.

---

## 6. Sources

### LangGraph / LangChain
- [LangChain Memory Docs](https://docs.langchain.com/oss/python/langgraph/add-memory)
- [Mastering LangGraph State Management in 2025](https://sparkco.ai/blog/mastering-langgraph-state-management-in-2025)
- [Adding Long-Term Memory to LangGraph and LangChain Agents](https://hindsight.vectorize.io/blog/2026/03/24/langgraph-longterm-memory)
- [The Architecture of Agent Memory: How LangGraph Really Works](https://dev.to/sreeni5018/the-architecture-of-agent-memory-how-langgraph-really-works-59ne)
- [Powering Long-Term Memory For Agents With LangGraph And MongoDB](https://www.mongodb.com/company/blog/product-release-announcements/powering-long-term-memory-for-agents-langgraph)
- [Launching Long-Term Memory Support in LangGraph](https://blog.langchain.com/launching-long-term-memory-support-in-langgraph/)
- [LangGraph Redis Integration](https://redis.io/blog/langgraph-redis-build-smarter-ai-agents-with-memory-persistence/)
- [LangChain Long-Term Memory Docs](https://docs.langchain.com/oss/python/langchain/long-term-memory)

### CrewAI
- [CrewAI Memory Documentation](https://docs.crewai.com/en/concepts/memory)
- [Deep Dive into CrewAI Memory Systems](https://sparkco.ai/blog/deep-dive-into-crewai-memory-systems)
- [CrewAI Memory Configuration and Storage](https://deepwiki.com/crewAIInc/crewAI/7.2-memory-configuration-and-storage)
- [CrewAI + Mem0: Production-Ready Memory](https://mem0.ai/blog/crewai-memory-production-setup-with-mem0)
- [AI Agent Memory: Comparative Analysis of LangGraph, CrewAI, and AutoGen](https://dev.to/foxgem/ai-agent-memory-a-comparative-analysis-of-langgraph-crewai-and-autogen-31dp)

### Microsoft AutoGen & Semantic Kernel
- [Microsoft Agent Framework Overview](https://learn.microsoft.com/en-us/agent-framework/overview/)
- [AutoGen - Microsoft Research](https://www.microsoft.com/en-us/research/project/autogen/)
- [Semantic Kernel Memory Packages GA Announcement](https://devblogs.microsoft.com/semantic-kernel/unlocking-the-power-of-memory-announcing-general-availability-of-semantic-kernels-memory-packages/)
- [Semantic Kernel Components](https://learn.microsoft.com/en-us/semantic-kernel/concepts/semantic-kernel-components)
- [Semantic Kernel In-Memory Vector Store Connector](https://learn.microsoft.com/en-us/semantic-kernel/concepts/vector-store-connectors/out-of-the-box-connectors/inmemory-connector)
- [Microsoft Agent Framework: Convergence of AutoGen and Semantic Kernel](https://cloudsummit.eu/blog/microsoft-agent-framework-production-ready-convergence-autogen-semantic-kernel)

### OpenAI
- [OpenAI Agents SDK - Sessions](https://openai.github.io/openai-agents-python/sessions/)
- [OpenAI Agents SDK - Memory Reference](https://openai.github.io/openai-agents-python/ref/memory/)
- [Context Engineering - Session Memory with OpenAI Agents SDK](https://cookbook.openai.com/examples/agents_sdk/session_memory)
- [Context Engineering for Personalization with OpenAI Agents SDK](https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization)
- [Assistants API v2 FAQ](https://help.openai.com/en/articles/8550641-assistants-api-v2-faq)

### Cognition (Devin)
- [How Cognition Uses Devin to Build Devin](https://cognition.ai/blog/how-cognition-uses-devin-to-build-devin)
- [Devin 2.0](https://cognition.ai/blog/devin-2)
- [Devin's 2025 Performance Review](https://cognition.ai/blog/devin-annual-performance-review-2025)
- [Coding Agents 101: The Art of Actually Getting Things Done](https://devin.ai/agents101)
- [Devin Advanced Mode Docs](https://docs.devin.ai/product-guides/advanced-mode)

### Cosine (Genie)
- [Cosine AI](https://cosine.sh)
- [Move over Devin: Cosine's Genie takes the AI coding crown (VentureBeat)](https://venturebeat.com/programming-development/move-over-devin-cosines-genie-takes-the-ai-coding-crown)
- [Cosine - Y Combinator](https://www.ycombinator.com/companies/cosine)

### Workflow Engines
- [Workflows: Windmill vs n8n vs Langflow vs Temporal](https://dev.to/frederic_zhou/workflows-windmill-vs-n8n-vs-langflow-vs-temporal-choosing-the-right-tool-for-the-job-23h5)
- [n8n AI Agent Node Memory: Complete Setup Guide for 2026](https://towardsai.net/p/machine-learning/n8n-ai-agent-node-memory-complete-setup-guide-for-2026)
- [Windmill Documentation](https://www.windmill.dev/docs/intro)

### NVIDIA Voyager
- [Voyager: An Open-Ended Embodied Agent with Large Language Models (Paper)](https://arxiv.org/abs/2305.16291)
- [Voyager Project Page](https://voyager.minedojo.org/)
- [NVIDIA Blog: AI Jim Fan on Voyager](https://blogs.nvidia.com/blog/ai-jim-fan/)
- [Voyager GitHub](https://github.com/MineDojo/Voyager)

### Reflexion / Self-Refine
- [Reflexion: Language Agents with Verbal Reinforcement Learning (Paper)](https://arxiv.org/abs/2303.11366)
- [Reflexion - Prompt Engineering Guide](https://www.promptingguide.ai/techniques/reflexion)
- [Building a Self-Correcting AI with Reflexion](https://medium.com/@vi.ha.engr/building-a-self-correcting-ai-a-deep-dive-into-the-reflexion-agent-with-langchain-and-langgraph-ae2b1ddb8c3b)
- [Reflecting on Reflexion (Noah Shinn)](https://nanothoughts.substack.com/p/reflecting-on-reflexion)

### MemGPT / Letta
- [MemGPT: Towards LLMs as Operating Systems (Paper)](https://arxiv.org/abs/2310.08560)
- [Letta Documentation - Introduction](https://docs.letta.com/concepts/memgpt/)
- [Letta - Memory Management Guide](https://docs.letta.com/advanced/memory-management/)
- [Agent Memory: How to Build Agents that Learn and Remember (Letta Blog)](https://www.letta.com/blog/agent-memory)
- [Letta GitHub](https://github.com/letta-ai/letta)
- [Stateful AI Agents: Deep Dive into Letta Memory Models](https://medium.com/@piyush.jhamb4u/stateful-ai-agents-a-deep-dive-into-letta-memgpt-memory-models-a2ffc01a7ea1)

### Mem0
- [Mem0 Research Paper: Building Production-Ready AI Agents](https://arxiv.org/abs/2504.19413)
- [State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [AI Memory Layer Guide (December 2025)](https://mem0.ai/blog/ai-memory-layer-guide)
- [Mem0 Platform Overview](https://docs.mem0.ai/platform/overview)
- [Mem0 GitHub](https://github.com/mem0ai/mem0)

### Zep (Graphiti)
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory (Paper)](https://arxiv.org/abs/2501.13956)
- [Zep Blog Post](https://blog.getzep.com/zep-a-temporal-knowledge-graph-architecture-for-agent-memory/)
- [Graphiti GitHub](https://github.com/getzep/graphiti)
- [Zep Platform](https://www.getzep.com/)

### Amazon Bedrock AgentCore
- [AgentCore Memory: Building Context-Aware Agents](https://aws.amazon.com/blogs/machine-learning/amazon-bedrock-agentcore-memory-building-context-aware-agents/)
- [AgentCore Memory Types Documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-types.html)
- [AgentCore Semantic Memory Strategy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/semantic-memory-strategy.html)
- [Building Smarter AI Agents: AgentCore Long-Term Memory Deep Dive](https://aws.amazon.com/blogs/machine-learning/building-smarter-ai-agents-agentcore-long-term-memory-deep-dive/)

### Claude Code
- [How Claude Remembers Your Project](https://code.claude.com/docs/en/memory)
- [Claude Code Auto Memory](https://claudefa.st/blog/guide/mechanics/auto-memory)
- [Claude Code Session Memory](https://claudefa.st/blog/guide/mechanics/session-memory)
- [Claude Code Auto Dream](https://claudefa.st/blog/guide/mechanics/auto-dream)
- [Claude Memory Tool API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)

### Cursor AI
- [Cursor 2.0 New AI Model Explained](https://www.codecademy.com/article/cursor-2-0-new-ai-model-explained)
- [Cursor AI Deep Dive: Features and Architecture](https://collabnix.com/cursor-ai-deep-dive-technical-architecture-advanced-features-best-practices-2025/)

### Cross-Cutting / Surveys
- [Best AI Agent Memory Systems in 2026: 8 Frameworks Compared](https://vectorize.io/articles/best-ai-agent-memory-systems)
- [Memory for AI Agents: A New Paradigm of Context Engineering](https://thenewstack.io/memory-for-ai-agents-a-new-paradigm-of-context-engineering/)
- [Context Engineering: LLM Memory and Retrieval for AI Agents (Weaviate)](https://weaviate.io/blog/context-engineering)
- [Survey of AI Agent Memory Frameworks (Graphlit)](https://www.graphlit.com/blog/survey-of-ai-agent-memory-frameworks)
- [Memory Engineering for AI Agents (Medium)](https://medium.com/@mjgmario/memory-engineering-for-ai-agents-how-to-build-real-long-term-memory-and-avoid-production-1d4e5266595c)
- [The 6 Best AI Agent Memory Frameworks in 2026](https://machinelearningmastery.com/the-6-best-ai-agent-memory-frameworks-you-should-try-in-2026/)
