"""Validate and compare the opt-in renderer benchmark's actual browser evidence.

Developer/agent tool only. Durations through finish() are queue/fence wall time;
GL raster timers cover instanced Gaussian draws, not resolve or presentation.
"""
import argparse
import base64
import json
import math
from pathlib import Path
from statistics import median


def attachments(report, name):
    if isinstance(report, dict):
        for attachment in report.get("attachments", []):
            if attachment["name"] == name:
                yield json.loads(base64.b64decode(attachment["body"])) if "body" in attachment else json.loads(Path(attachment["path"]).read_text(encoding="utf8"))
        for value in report.values():
            yield from attachments(value, name)
    elif isinstance(report, list):
        for value in report:
            yield from attachments(value, name)


def summary(samples):
    if not samples or any(not math.isfinite(x) or x < 0 for x in samples):
        raise ValueError("Missing or invalid measurement samples")
    ordered = sorted(samples)
    return {"count": len(samples), "medianMs": median(samples), "p95Ms": ordered[min(len(samples) - 1, int(len(samples) * .95))]}


def series(path):
    report = json.loads(Path(path).read_text(encoding="utf8"))
    if report["stats"]["unexpected"] or report["stats"]["flaky"] or report["stats"]["skipped"]:
        raise ValueError(f"Incomplete/failed browser cohort: {path}")
    result = {}
    for value in attachments(report, "rendering-profile.json"):
        if value["errors"] or value["memory"]["bytes"] or value["memory"]["allocations"]:
            raise ValueError("Renderer failure or retained measured allocations")
        for mode in value["modes"]:
            if mode["beforeQueries"] != mode["afterQueries"] or mode["displaySequence"] != mode["afterQueryDisplaySequence"]:
                raise ValueError("Query changed the display/sample clock")
            for field in ("frameCompletionMs", "fixedFrameCompletionMs"):
                if len(mode[field]["samples"]) != 120:
                    raise ValueError("Each warm series requires 120 measured frames")
            key = (value["backend"], value["fixture"], mode["mode"])
            result.setdefault(key, []).append((value, mode))
    expected = {(backend, fixture, mode) for backend in ("webgpu", "webgl2") for fixture in ("base", "count", "SH0", "resolution", "DPR2") for mode in ("sorted", "steady")}
    if result.keys() != expected:
        raise ValueError("Missing/extra backend, mode or controlled fixture")
    for values in result.values():
        if len(values) != 3 or {v[0]["repetition"] for v in values} != {0, 1, 2}:
            raise ValueError("Each series requires three independent cold starts")
    return result


def measurements(values):
    modes = [value[1] for value in values]
    output = {"motion": summary([x for mode in modes for x in mode["frameCompletionMs"]["samples"]]),
              "fixed": summary([x for mode in modes for x in mode["fixedFrameCompletionMs"]["samples"]])}
    for field in ("motionSubmissionMs", "motionCompletionMs", "fixedSubmissionMs", "fixedCompletionMs"):
        output[field] = summary([x for mode in modes for x in mode[field]])
    for field in ("firstDrawMs", "pickMs", "surfaceMs", "captureMs"):
        output[field] = summary([mode[field] for mode in modes])
    output["coldCreateMs"] = summary([value[0]["coldCreateMs"] for value in values])
    output["peakLogicalBytes"] = max(mode["retained"]["peakBytes"] for mode in modes)
    output["fixedSortJobs"] = sum(sum(event["action"] == "sort" for event in mode["fixedProfile"]["work"]) if value["backend"] == "webgl2"
                                  else mode["fixedProfile"]["counts"].get("Stable depth sort", 0) for value, mode in values)
    output["fixedOrderTextureUploads"] = sum(mode["fixedProfile"]["counts"].get("texSubImage2D", 0) for mode in modes)
    output["fixedProjectionDispatches"] = sum(mode["fixedProfile"]["counts"].get("Project Gaussians", 0) for mode in modes)
    raster = [x for mode in modes for x in mode["motionProfile"]["gpuRasterMs"]]
    output["glGaussianDrawGpuMs"] = summary(raster) if raster else None
    output["gpuTimerScope"] = modes[0]["motionProfile"]["timerStatus"]
    work = [event for mode in modes for event in mode["motionProfile"]["work"] if event["action"] == "sort"]
    output["workerSort"] = {field: summary([event[field] for event in work]) for field in ("roundTripMs", "queueMs", "computeMs", "transportAndWakeupMs")} if work else None
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--optimized", required=True)
    parser.add_argument("--input-baseline")
    parser.add_argument("--input-optimized")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    before, after = series(args.baseline), series(args.optimized)
    rows = []
    for key in sorted(before):
        b, a = measurements(before[key]), measurements(after[key])
        if a["fixedSortJobs"] or a["fixedOrderTextureUploads"] or a["fixedProjectionDispatches"]:
            raise ValueError(f"Redundant installed-order/projection work remains: {key}")
        rows.append({"backend": key[0], "fixture": key[1], "mode": key[2], "baseline": b, "optimized": a,
                     "environment": after[key][0][0]["environment"],
                     "count": after[key][0][0]["count"], "shDegree": after[key][0][0]["shDegree"],
                     "framebuffer": after[key][0][0]["framebuffer"], "dpr": after[key][0][0]["dpr"]})
    inputs = {}
    for name, path in (("baseline", args.input_baseline), ("optimized", args.input_optimized)):
        if path:
            report = json.loads(Path(path).read_text(encoding="utf8"))
            if report["stats"]["unexpected"] or report["stats"]["flaky"] or report["stats"]["skipped"]:
                raise ValueError("Input cohort failed")
            observations = list(attachments(report, "app-input-completion.json"))
            if len(observations) != 6 or any(len(value["samples"]) != 120 for value in observations):
                raise ValueError("Input cohort requires 120 events per repetition and three repetitions per backend")
            inputs[name] = {backend: summary([s["inputToCompletionMs"] for v in observations if v["backend"] == backend for s in v["samples"]]) for backend in ("webgpu", "webgl2")}
    output = {"schemaVersion": 1, "scope": "Local automated Chromium; queue/fence wall time, isolated GL Gaussian draw timers, logical reservations. Physical presentation/memory and WebGPU timestamps unavailable.",
              "series": rows, "appInputToGpuCompletion": inputs}
    Path(args.out).write_text(json.dumps(output, indent=2) + "\n", encoding="utf8")
    print(f"Validated {len(rows)} matched series, 360 motion and 360 fixed samples each, {len(inputs)} input cohorts")


if __name__ == "__main__":
    main()
