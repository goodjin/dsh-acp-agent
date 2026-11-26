/**
 * Taking over ACP-backed sessions as they are created.
 *
 * `agent/created` is serial and awaited before the agent reaches the loop, and
 * queued input waits for its listeners — so patching here cannot race the first
 * turn. The payload carries the live agent, which is the only moment the preset
 * is worth reading.
 *
 * No imports from the DSH runtime packages, on purpose: the published versions
 * lag far behind what actually runs (0.1.0-rc.6 published, 0.2.0-rc.2 running),
 * and `ReactLoopAgent` cannot be imported at all — it is re-exported from
 * nowhere and its package exposes no subpath for it. So this states the one
 * event it listens for, and the caller adapts.
 */
import { projectStepContent } from "./index.js";
import { installAcpDispatch, resolvePreset } from "./dispatch.js";
import { makeSessionFactory } from "./factory.js";
import { modelsOfPreset, registerCatalog, runtimeModels, runtimeModelsWithDeclaredWindows } from "./catalog-registration.js";
import { modelPluginStream } from "./model-plugins.js";
import { buildPresetTable, sessionsRegistry } from "./registry.js";
export async function attachAcpDispatch(ctx, config, options) {
    // The agent's own `session/new` reports, per preset, shared by the factory
    // seam and the catalog registration below, so the picker and the sessions
    // read the same source.
    const runtimeModelReports = runtimeModelsWithDeclaredWindows(reportedPresetId => (reportedPresetId in config.presets ? config.presets[reportedPresetId]?.models : undefined));
    const factory = makeSessionFactory(config, {
        ...options,
        // No catalog-owning caller supplied a report sink: record into the shared
        // ledger this attach registered the catalog with.
        ...(options.onRuntimeModels === undefined
            ? { onRuntimeModels: (presetId, models) => { runtimeModelReports.record(presetId, models); } }
            : {}),
    });
    const table = buildPresetTable(config, factory, sessionsRegistry());
    // What makes the external agent's models appear in DSH's own model picker:
    // the catalog is global to this Host generation and already read by it. The
    // The takeover listener is registered synchronously, before the catalog read:
    // a session created the moment this row mounts must still be taken over, and
    // the listener cannot wait on the whitelist disk read below.
    ctx.on('agent/created', payload => {
        const agent = payload.agent;
        const binding = resolvePreset(agent, table, options.presetOf);
        // Not ours: leave this session exactly as it was.
        if (binding === undefined)
            return;
        installAcpDispatch(agent, table, {
            ...(options.presetOf === undefined ? {} : { presetOf: options.presetOf }),
            positionOf: candidate => options.positionOf(candidate),
            produce: (result, position) => 
            // The numbers the loop announced stand: content grouped under any other
            // step is dropped by the conversation view.
            projectStepContent(result.frames, { turn: position.turn, step: position.step, dialect: binding.dialect }),
            write: events => options.write?.(agent, events),
        });
    });
    // The catalog is global to this Host generation and already read by it. The
    // list reads the agent's own report once a session has opened, and degrades
    // to the configured list until then. registerCatalog is async now (it reads
    // each preset's positive whitelist off disk first), but the picker does not
    // need the takeover — it only needs the models eventually, so the read runs
    // here without blocking the listener above.
    await registerCatalog(ctx, config, {
        modelsOf: presetId => modelsOfPreset(config, factory, presetId),
        runtimeModelsOf: presetId => runtimeModelReports.modelsOf(presetId),
        dialectOf: presetId => table.get(presetId)?.dialect,
        modelStream: modelPluginStream(config, {
            onRuntimeModels: (presetId, models) => { runtimeModelReports.record(presetId, models); },
        }),
    });
}
