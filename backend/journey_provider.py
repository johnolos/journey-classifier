"""promptfoo python provider. Returns classify() output; also reports whether the expected IDs were retrievable."""
import os

import journey


def call_api(prompt, options, context):
    # promptfoo's Python provider does not apply config.env itself; the provider config selects the backend here
    os.environ.update(options.get("config", {}).get("env", {}))
    v = context["vars"]
    out = journey.classify(v["query"], v.get("lat"), v.get("lon"), v.get("now"))
    cands = set(out["debug"]["candidates"])
    # promptfoo expands array-valued vars into one test per element, so from_ok/to_ok are comma-joined strings
    ok = {k: set(v[k].split(",")) if v.get(k) else None for k in ("from_ok", "to_ok")}
    out["retrievable"] = {
        "from": ok["from_ok"] is None or bool(ok["from_ok"] & cands),
        "to": ok["to_ok"] is None or bool(ok["to_ok"] & cands),
    }
    return {"output": out}
