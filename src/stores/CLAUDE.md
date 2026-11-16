# Notes for agents: stores

- A store run (`generateOrtho`, `generateDem`, …) takes run units, not the dialog's:
  build its settings with `core/runSettings.js`, as the dialogs and the Workflow Builder
  do. The defaults are in dialog units (`maxCost: 0` means off in the dialog and a zero
  cost limit in the run; `depthTolRel` is a percentage), so `{ ...ORTHO_DEFAULTS }`
  passed straight in gives an empty orthophoto.
- Per-project state registers with `registerProjectStore` (`projectStores.js`), or it
  neither saves nor reopens with the project.
- Turn reactive data into plain arrays before posting it to a worker; big data stays
  in typed arrays (ARCHITECTURE ▸ *Conventions worth knowing*).
- A change to what a project saves follows docs/project-format.md (a default for a new
  field, or a format migration with its fixture).
