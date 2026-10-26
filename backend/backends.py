"""Model seam. decide(state, questions) -> answers in Clef's response shape."""
import json
import os
import urllib.error
import urllib.request


class BackendError(RuntimeError):
    pass


class BackendUnavailable(BackendError):
    """Backend not accepting connections (e.g. Clef still loading)."""


def decide_clef(state: dict, questions: dict) -> dict:
    url = os.environ.get("CLEF_URL", "http://127.0.0.1:8000/v1/systemone")
    body = json.dumps({"model": os.environ.get("JOURNEY_MODEL", "clef-flash"), "state": state, "questions": questions}).encode()
    req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            text = r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        raise BackendError(f"clef {e.code}: {e.read().decode(errors='replace')}") from None
    except urllib.error.URLError as e:
        raise BackendUnavailable(f"clef unreachable at {url}: {e.reason}") from None
    except OSError as e:
        raise BackendError(f"clef request to {url} failed: {e}") from None
    try:
        return json.loads(text)["answers"]
    except (ValueError, KeyError, TypeError):
        raise BackendError(f"clef response has no usable 'answers': {text}") from None


def render_prompt(state: dict, questions: dict) -> str:
    lines = ["Read the state and answer every question. Reply with ONLY a JSON object whose keys are the question ids.",
             "For 'noul' questions answer true or false. For 'choice' questions answer with exactly one of the option keys.",
             "", "STATE:", json.dumps(state, ensure_ascii=False), "", "QUESTIONS:"]
    for qid, q in questions.items():
        lines.append(f'"{qid}" ({q["type"]}): {q.get("instructions", "")}')
        for key, desc in (q.get("criteria") or {}).items():
            lines.append(f"  - {key}: {desc}")
    return "\n".join(lines)


def coerce(raw: dict, questions: dict) -> dict:
    """Validate a plain {question_id: value} object and reshape it to Clef's answer shape."""
    if not isinstance(raw, dict):
        raise BackendError(f"expected a JSON object, got: {raw!r}")
    out = {}
    for qid, q in questions.items():
        if qid not in raw:
            raise BackendError(f"{qid}: missing")
        if q["type"] == "noul":
            v = raw[qid].strip().lower() if isinstance(raw[qid], str) else raw[qid]
            if isinstance(v, (bool, int, str)) and v in (True, False, "true", "false"):
                out[qid] = {"type": "noul", "noul": 1.0 if v in (True, "true") else 0.0}
            else:
                raise BackendError(f"{qid}: {raw[qid]!r} is not a boolean")
        else:
            choice = str(raw[qid])
            if choice not in q["criteria"]:
                raise BackendError(f"{qid}: {choice!r} is not an allowed option")
            out[qid] = {"type": "choice", "choice": choice, "confidence": 1.0, "probabilities": {}}
    return out


def decide_openai(state: dict, questions: dict) -> dict:
    from openai import OpenAI, OpenAIError
    if "JOURNEY_MODEL" not in os.environ:
        raise BackendError("JOURNEY_MODEL is required for the openai backend")
    client = OpenAI(base_url=os.environ.get("OPENAI_BASE_URL", "http://localhost:11434/v1"),
                    api_key=os.environ.get("OPENAI_API_KEY", "none"))
    try:
        r = client.chat.completions.create(
            model=os.environ["JOURNEY_MODEL"], temperature=0,
            response_format={"type": "json_object"},
            messages=[{"role": "user", "content": render_prompt(state, questions)}],
        )
        content = r.choices[0].message.content
    except IndexError:
        raise BackendError("openai response has no choices") from None
    except OpenAIError as e:
        raise BackendError(f"openai backend failed: {e}") from None
    try:
        return coerce(json.loads(content), questions)
    except (ValueError, TypeError):
        raise BackendError(f"openai response is not JSON: {content!r}") from None


def answer_tool_schema(questions: dict) -> dict:
    props = {qid: {"type": "boolean"} if q["type"] == "noul" else {"type": "string", "enum": list(q["criteria"])}
             for qid, q in questions.items()}
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


def decide_anthropic(state: dict, questions: dict) -> dict:
    import anthropic
    # Sonnet 5.5 rejects forced tool_choice (400), so: auto + strict schema + prompt naming the tool.
    # Limitation: no retry if the model answers in text instead of calling the tool; ceiling is one BackendError.
    tool = {"name": "answer", "description": "Submit the answers to all questions.",
            "input_schema": answer_tool_schema(questions), "strict": True}
    prompt = render_prompt(state, questions) + "\n\nSubmit your answers by calling the `answer` tool."
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise BackendError("anthropic backend needs ANTHROPIC_API_KEY")
    try:
        r = anthropic.Anthropic().messages.create(
            model=os.environ.get("JOURNEY_MODEL", "claude-sonnet-5-5"), max_tokens=4096,
            tools=[tool], tool_choice={"type": "auto"},
            messages=[{"role": "user", "content": prompt}],
        )
    except anthropic.AnthropicError as e:
        raise BackendError(f"anthropic backend failed: {e}") from None
    for block in r.content:
        if block.type == "tool_use" and block.name == "answer":
            return coerce(block.input, questions)
    raise BackendError(f"anthropic response has no answer tool_use (stop_reason={r.stop_reason})")


def decide_d1(state: dict, questions: dict) -> dict:
    """Liquid d1 via mlx_vlm server (/v1/decisions); reshape its answers to Clef's."""
    url = os.environ.get("CLEF_URL", "http://127.0.0.1:8002/v1/decisions")
    body = json.dumps({"model": os.environ.get("JOURNEY_MODEL", "LiquidAI/d1-3B-MLX-fp16"),
                       "state": state, "questions": questions}).encode()
    req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = json.loads(r.read())["answers"]
    except urllib.error.HTTPError as e:
        raise BackendError(f"d1 {e.code}: {e.read().decode(errors='replace')}") from None
    except urllib.error.URLError as e:
        raise BackendUnavailable(f"d1 unreachable at {url}: {e.reason}") from None
    except (OSError, ValueError, KeyError) as e:
        raise BackendError(f"d1 request to {url} failed: {e}") from None
    out = {}
    for qid, a in raw.items():
        if a["type"] == "bool":
            out[qid] = {"type": "noul", "noul": a["probability"]}
        else:
            out[qid] = {"type": "choice", "choice": a["value"], "probabilities": a["probabilities"],
                        "confidence": a["probabilities"][a["value"]]}
    return out


BACKENDS = {"clef": decide_clef, "openai": decide_openai, "anthropic": decide_anthropic, "d1": decide_d1}


def decide(state: dict, questions: dict) -> dict:
    name = os.environ.get("JOURNEY_BACKEND", "clef")
    if name not in BACKENDS:
        raise BackendError(f"unknown JOURNEY_BACKEND {name!r}; options: {sorted(BACKENDS)}")
    return BACKENDS[name](state, questions)
