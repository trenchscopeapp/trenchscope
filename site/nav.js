// Osmo Basic Navigation Bar: preserve the state and control attribute contract. Shared by the
// homepage and the docs page.
export function initBasicNavigationBar() {
  document.querySelectorAll('[data-nav-status]').forEach((nav) => {
    const toggle = nav.querySelector('[data-nav-control="toggle"]');
    const setNav = (active) => {
      nav.setAttribute('data-nav-status', active ? 'active' : 'not-active');
      toggle?.setAttribute('aria-expanded', String(active));
      toggle?.setAttribute('aria-label', active ? 'Close navigation' : 'Open navigation');
    };
    nav.querySelectorAll('[data-nav-control]').forEach((control) => {
      control.addEventListener('click', () => {
        const action = control.getAttribute('data-nav-control');
        const active = nav.getAttribute('data-nav-status') === 'active';
        setNav(action === 'open' || (action === 'toggle' && !active));
      });
    });
    nav.querySelectorAll('[data-nav-list] a').forEach(link => link.addEventListener('click', () => setNav(false)));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && nav.getAttribute('data-nav-status') === 'active') {
        setNav(false);
        toggle?.focus();
      }
    });
    document.addEventListener('pointerdown', event => { if (!nav.contains(event.target)) setNav(false); });
    window.matchMedia('(min-width: 992px)').addEventListener('change', () => setNav(false));
    setNav(false);
  });
}
