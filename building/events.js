import crypto from 'node:crypto'

const eventStore = new Map()
const MAX_EVENTS_IN_MEMORY = 500

export async function addDeploymentEvent(deps, deploymentId, userId, projectId, stage, message, extras = {}) {
  const { io, supabaseAdmin } = deps

  const event = {
    id: crypto.randomUUID(),
    deploymentId,
    stage,
    message,
    timestamp: new Date().toISOString(),
    log: extras.log ?? null,
    liveUrl: extras.liveUrl ?? null,
  }

  const existing = eventStore.get(deploymentId) ?? []
  const updated = [...existing, event]
  if (updated.length > MAX_EVENTS_IN_MEMORY) updated.splice(0, updated.length - MAX_EVENTS_IN_MEMORY)
  eventStore.set(deploymentId, updated)

  io.to(`deployment:${deploymentId}`).emit('deployment:event', event)

  await supabaseAdmin
    .from('osstack_deployments')
    .update({ status: stage, detail: message })
    .eq('id', deploymentId)
    .eq('user_id', userId)

  const { error } = await supabaseAdmin.from('osstack_deployment_events').insert({
    id: event.id,
    deployment_id: deploymentId,
    user_id: userId,
    project_id: projectId,
    stage,
    message,
    log: event.log,
    live_url: event.liveUrl,
    created_at: event.timestamp,
  })

  if (error && !String(error.message ?? '').includes('osstack_deployment_events')) {
    throw error
  }

  return event
}

export async function getEventsForDeployment(supabaseAdmin, deploymentId) {
  const memoryEvents = eventStore.get(deploymentId) ?? []

  const { data, error } = await supabaseAdmin
    .from('osstack_deployment_events')
    .select('*')
    .eq('deployment_id', deploymentId)
    .order('created_at', { ascending: true })

  if (error) return memoryEvents

  const dbEvents = (data ?? []).map(rowToEvent)
  const dbIds = new Set(dbEvents.map((e) => e.id))
  const merged = [...dbEvents, ...memoryEvents.filter((e) => !dbIds.has(e.id))]

  return merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
}

export function getMemoryEvents(deploymentId) {
  return eventStore.get(deploymentId) ?? []
}

function rowToEvent(row) {
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    stage: row.stage,
    message: row.message,
    timestamp: row.created_at,
    log: row.log,
    liveUrl: row.live_url,
  }
}
