// Late binding for the reconstruction store's factories. The store's parts depend on
// each other in both directions (the region needs the main sparse cloud, which comes
// later; everything saves), and a factory takes its dependencies when it is called.
// A name the store defines further down is passed as one of these: it is looked up
// when it is used, not when the factory is made, so moved code keeps calling `save()`
// and reading `x.value` as before.

// A function defined later: late(() => save) is called like save.
export const late =
  (get) =>
  (...args) =>
    get()(...args)

// A ref or computed defined later: lateRef(() => r).value reads (and sets) r.value,
// inside a computed too (the read goes through to the real ref, so it is tracked).
export const lateRef = (get) => ({
  get value() {
    return get().value
  },
  set value(v) {
    get().value = v
  },
})
