import { describe, it, expect, vi } from 'vitest'
import { createAppUpdate } from './useAppUpdate.js'

function setup() {
  const reload = vi.fn()
  const apply = vi.fn()
  const app = createAppUpdate({ reload })
  app.setApplyUpdate(apply)
  return { app, reload, apply }
}

describe('createAppUpdate', () => {
  it('shows the prompt for a waiting version and activates it on Reload', () => {
    const { app, reload, apply } = setup()
    app.onNeedRefresh()
    expect(app.updateReady.value).toBe(true)
    app.reloadIntoUpdate()
    expect(apply).toHaveBeenCalledWith(true)
    expect(reload).not.toHaveBeenCalled()
    // The new worker takes control of this (idle) tab: reload now.
    app.onNeedReload()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not activate the update from a busy tab', () => {
    const { app, apply } = setup()
    app.onNeedRefresh()
    app.setBusy(true)
    app.reloadIntoUpdate()
    expect(apply).not.toHaveBeenCalled()
  })

  it('defers the reload a new worker forces on a busy tab until its work ends', () => {
    const { app, reload } = setup()
    app.onNeedRefresh()
    app.setBusy(true)
    // Another tab clicked Reload: the new worker now controls this one too.
    app.onNeedReload()
    expect(reload).not.toHaveBeenCalled()
    expect(app.updateReady.value).toBe(true)
    expect(app.updateActive.value).toBe(true)
    app.setBusy(true)
    expect(reload).not.toHaveBeenCalled()
    app.setBusy(false)
    expect(reload).toHaveBeenCalledTimes(1)
    // Only once, however often the state is reported afterwards.
    app.setBusy(false)
    app.onNeedReload()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads an idle tab when another tab switched', () => {
    const { app, reload } = setup()
    app.setBusy(false)
    app.onNeedReload()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('Later hides a waiting update but not one already active in this tab', () => {
    const { app } = setup()
    app.onNeedRefresh()
    app.postponeUpdate()
    expect(app.updateReady.value).toBe(false)
    app.setBusy(true)
    app.onNeedReload()
    app.postponeUpdate()
    expect(app.updateReady.value).toBe(true)
  })

  it('Reload on an already active update reloads directly once idle', () => {
    const { app, reload, apply } = setup()
    app.setBusy(true)
    app.onNeedReload()
    app.setBusy(false) // reloads here already
    app.reloadIntoUpdate()
    expect(apply).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
