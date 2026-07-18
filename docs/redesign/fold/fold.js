(() => {
  const display = document.getElementById('foldDisplay')
  const dock = document.getElementById('foldDock')
  const grip = document.getElementById('dockGrip')
  const settingsButton = document.getElementById('dockSettings')
  const popover = document.getElementById('dockPopover')
  const closePopover = document.getElementById('closeDockPopover')
  const toast = document.getElementById('toast')
  const screens = [...document.querySelectorAll('[data-screen]')]
  const dockTabs = [...document.querySelectorAll('.dock-tab[data-nav-target]')]
  const positionButtons = [...document.querySelectorAll('[data-dock-position]')]
  let activeScreen = 'home'
  let toastTimer

  const screenToTab = screen => screen === 'book' ? 'library' : screen

  function showScreen(screen) {
    const target = screens.find(node => node.dataset.screen === screen)
    if (!target) return
    screens.forEach(node => node.classList.toggle('is-active', node === target))
    activeScreen = screen
    const activeTab = screenToTab(screen)
    dockTabs.forEach(button => {
      const on = button.dataset.navTarget === activeTab
      button.classList.toggle('is-on', on)
      const icon = button.querySelector('.ms')
      if (icon) icon.classList.toggle('fill', on)
    })
  }

  document.addEventListener('click', event => {
    const nav = event.target.closest('[data-nav-target]')
    if (nav) showScreen(nav.dataset.navTarget)
  })

  document.getElementById('openFullBook').addEventListener('click', () => showScreen('book'))
  document.getElementById('backToLibrary').addEventListener('click', () => showScreen('library'))

  const books = {
    winter: { title: 'A Winter of Salt', cover: 'A Winter<br>of Salt', series: 'Cinderfall · 4', cycle: 'Cinderfall cycle · book 4', author: 'Maren Holloway · narrated by Aoife Doyle', className: 'cover-purple', description: 'When the salt roads freeze over, the Ferryman calls in every debt owed to the Cinderfall. Maren must cross a sea that remembers her name to buy back a single winter—and the price is climbing with the tide.' },
    ember: { title: 'The Ember Gate', cover: 'The Ember<br>Gate', series: 'Cinderfall · 3', cycle: 'Cinderfall cycle · book 3', author: 'Maren Holloway · narrated by Ada Vale', className: 'cover-ember', description: 'Beyond the city’s last furnace, a door appears in the ash. Elian has carried its map for years—without knowing the map remembers him too.' },
    atlas: { title: 'A Quiet Atlas', cover: 'A Quiet<br>Atlas', series: 'Archive · 1', cycle: 'The Archive · book 1', author: 'Ren Ito · narrated by Samira Chen', className: 'cover-teal', description: 'A cartographer who maps forgotten places finds a city that only appears when nobody is looking for it.' },
    copper: { title: 'Copper & Rain', cover: 'Copper &<br>Rain', series: 'Foundry · 2', cycle: 'Foundry · book 2', author: 'Lena Voss · narrated by Theo Grant', className: 'cover-gold', description: 'In a city built above the clouds, every storm carries a memory—and one engineer has learned how to listen.' },
    room: { title: 'The Long Room', cover: 'The Long<br>Room', series: 'Night House', cycle: 'Night House · standalone', author: 'T. M. Bell · narrated by Rosa Finch', className: 'cover-purple', description: 'The room grows one foot every night. By winter, it may finally be long enough to reach what waits on the other side.' },
    cedar: { title: 'North of Cedar', cover: 'North of<br>Cedar', series: 'Field Notes', cycle: 'Field Notes · volume 1', author: 'Mara Field · narrated by Ben Hale', className: 'cover-green', description: 'A quiet field journal becomes the only reliable map through a forest that rearranges itself after dark.' }
  }

  const detailCover = document.getElementById('detailCover')
  document.querySelectorAll('.library-book').forEach(button => {
    button.addEventListener('click', () => {
      const book = books[button.dataset.book]
      if (!book) return
      document.querySelectorAll('.library-book').forEach(node => node.classList.toggle('is-selected', node === button))
      detailCover.classList.remove('cover-purple', 'cover-ember', 'cover-teal', 'cover-gold', 'cover-green')
      detailCover.classList.add(book.className)
      document.getElementById('detailTitle').textContent = book.title
      document.getElementById('detailCoverTitle').innerHTML = book.cover
      document.getElementById('detailSeries').textContent = book.series
      document.getElementById('detailCycle').textContent = book.cycle
      document.getElementById('detailAuthor').textContent = book.author
      document.getElementById('detailDescription').textContent = book.description
    })
  })

  function openPanel(name) {
    document.querySelectorAll('[data-panel]').forEach(button => {
      const on = button.dataset.panel === name
      button.classList.toggle('is-on', on)
      button.setAttribute('aria-selected', String(on))
    })
    document.querySelectorAll('[data-panel-view]').forEach(view => view.classList.toggle('is-active', view.dataset.panelView === name))
    document.querySelectorAll('.player-actions [data-panel-target]').forEach(button => button.classList.toggle('is-on', button.dataset.panelTarget === name))
  }
  document.querySelectorAll('[data-panel],[data-panel-target]').forEach(button => button.addEventListener('click', () => openPanel(button.dataset.panel || button.dataset.panelTarget)))

  function showToast(message) {
    toast.textContent = message
    toast.classList.add('is-visible')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 1700)
  }

  function setDockPosition(position, announce = true) {
    const safe = ['left', 'both', 'right'].includes(position) ? position : 'both'
    dock.classList.remove('dock-left', 'dock-both', 'dock-right', 'is-dragging')
    dock.classList.add(`dock-${safe}`)
    dock.style.removeProperty('top')
    dock.style.removeProperty('bottom')
    dock.style.removeProperty('left')
    dock.style.removeProperty('transform')
    positionButtons.forEach(button => button.classList.toggle('is-on', button.dataset.dockPosition === safe))
    try { localStorage.setItem('hs-fold-dock-position', safe) } catch (_) {}
    if (announce) showToast(`Dock moved to ${safe === 'both' ? 'both screens' : `${safe} screen`}`)
  }

  positionButtons.forEach(button => button.addEventListener('click', () => setDockPosition(button.dataset.dockPosition)))
  try { setDockPosition(localStorage.getItem('hs-fold-dock-position') || 'both', false) } catch (_) { setDockPosition('both', false) }

  function setPopover(open) {
    popover.hidden = !open
    settingsButton.setAttribute('aria-expanded', String(open))
  }
  settingsButton.addEventListener('click', () => setPopover(popover.hidden))
  closePopover.addEventListener('click', () => setPopover(false))
  document.addEventListener('keydown', event => { if (event.key === 'Escape') setPopover(false) })

  let drag = null
  grip.addEventListener('pointerdown', event => {
    const dockRect = dock.getBoundingClientRect()
    const displayRect = display.getBoundingClientRect()
    drag = { dx: event.clientX - dockRect.left, dy: event.clientY - dockRect.top, displayRect }
    dock.classList.add('is-dragging')
    dock.style.left = `${dockRect.left - displayRect.left}px`
    dock.style.top = `${dockRect.top - displayRect.top}px`
    dock.style.bottom = 'auto'
    dock.style.transform = 'none'
    grip.setPointerCapture(event.pointerId)
  })
  function moveDrag(event) {
    if (!drag) return
    const rect = dock.getBoundingClientRect()
    const maxX = drag.displayRect.width - rect.width - 10
    const maxY = drag.displayRect.height - rect.height - 10
    const x = Math.max(10, Math.min(maxX, event.clientX - drag.displayRect.left - drag.dx))
    const y = Math.max(10, Math.min(maxY, event.clientY - drag.displayRect.top - drag.dy))
    dock.style.left = `${x}px`
    dock.style.top = `${y}px`
  }
  grip.addEventListener('pointermove', moveDrag)
  document.addEventListener('pointermove', moveDrag)
  function finishDrag(event) {
    if (!drag) return
    const dockRect = dock.getBoundingClientRect()
    const center = (dockRect.left - drag.displayRect.left + dockRect.width / 2) / drag.displayRect.width
    const position = center < .38 ? 'left' : center > .62 ? 'right' : 'both'
    drag = null
    if (event && grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId)
    setDockPosition(position)
  }
  grip.addEventListener('pointerup', finishDrag)
  grip.addEventListener('pointercancel', finishDrag)
  document.addEventListener('pointerup', finishDrag)
  document.addEventListener('pointercancel', finishDrag)

  showScreen(activeScreen)
})()
