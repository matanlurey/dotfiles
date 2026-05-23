---
name: grill-me
description: Conduct a rigorous technical interview on the current codebase. Analyzes the project, generates challenging questions about architecture, design decisions, edge cases, and trade-offs, then presents them as an interactive interview using the pi-interview tool. Use when the user wants to test their understanding of a codebase or prepare for a code review.
---

# Grill Me — Technical Interview on Your Codebase

## Overview

This skill analyzes the current project and conducts a tough but fair technical interview. It tests the user's understanding of their own codebase — architecture decisions, edge cases, failure modes, and trade-offs.

## How It Works

1. **Analyze the codebase**: Read key files, understand the architecture, identify interesting design decisions, potential issues, and non-obvious behaviors.

2. **Generate questions**: Create 8-12 challenging questions across these categories:
   - **Architecture**: Why was X structured this way? What are the trade-offs?
   - **Edge cases**: What happens when Y fails? How does Z handle concurrent access?
   - **Design decisions**: Why this library/pattern over alternatives?
   - **Failure modes**: What breaks if this service goes down? Where are the single points of failure?
   - **Code understanding**: What does this function actually do? Walk through this flow.
   - **Improvements**: What would you change? What's the biggest risk?

3. **Present as interview**: Use the `interview` tool with a mix of:
   - `single` choice questions (pick the correct answer)
   - `multi` choice questions (select all that apply)
   - `text` questions (explain in your own words)
   - Include code snippets in questions using `content` blocks when referencing specific code

4. **Grade and debrief**: After submission, review answers, explain what was right/wrong, and highlight areas to study.

## Question Design Guidelines

- **Be specific to THIS codebase** — no generic CS trivia
- **Include plausible wrong answers** — make single/multi choices genuinely tricky
- **Reference actual code** — use `content` blocks with real snippets from the project
- **Mix difficulty** — start accessible, escalate to hard
- **Test understanding, not memorization** — "What would happen if..." over "What is the name of..."
- **Include at least 2 text questions** — force the user to explain concepts in their own words

## Interview Format

```json
{
  "title": "Codebase Deep Dive: {project-name}",
  "description": "A technical interview on your codebase. Answer honestly — this is for your own growth.",
  "questions": [
    {
      "id": "arch-1",
      "type": "single",
      "question": "Why does the X module use pattern Y instead of Z?",
      "options": ["Because of A", "Because of B", "Because of C", "Because of D"],
      "context": "Look at how X is implemented in src/x.go",
      "content": {
        "source": "// relevant code snippet",
        "lang": "go",
        "file": "src/x.go"
      }
    },
    {
      "id": "edge-1",
      "type": "text",
      "question": "What happens if the database connection drops mid-transaction in the Y handler? Walk through the failure path.",
      "context": "Think about error handling, retries, and data consistency."
    }
  ]
}
```

## Execution Steps

1. Use `bash` and `read` to explore the project structure, key files, config, and tests
2. Identify 8-12 interesting areas to probe
3. Write the questions JSON to a temp file
4. Call `interview({ questions: "/path/to/questions.json" })`
5. Review the responses
6. Provide detailed feedback on each answer with explanations

## Grading

After the user submits, provide:
- Score: X/Y correct (for choice questions)
- Per-question breakdown: ✅ correct, ❌ wrong (with explanation), or 📝 (text — provide feedback)
- Overall assessment: strengths, blind spots, areas to explore
- Specific files/docs to review for missed questions
