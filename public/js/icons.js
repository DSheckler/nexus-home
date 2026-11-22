// Iconos SVG de trazo fino (sin librerías externas).
(function () {
  const s = (body) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

  const cloud = '<path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.1 4.5 4.5 0 0 0 7 18Z"/>';

  window.NEXUS_ICONS = {
    sun: s('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>'),
    moon: s('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>'),
    partlyNight: s('<path d="M12.5 9.2A3.6 3.6 0 0 1 8.3 4.5a4.6 4.6 0 0 0-3 7.6"/><path d="M9 20h8.5a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 8.4 12.2 3.9 3.9 0 0 0 9 20Z"/>'),
    fog: s('<path d="M7 13h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 4.1 4.5 4.5 0 0 0 7 13Z"/><path d="M4 16.5h16M6 20h12"/>'),
    storm: s('<path d="M7 15h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 6.1 4.5 4.5 0 0 0 7 15Z"/><path d="M12.5 15 10.5 18.5h3l-2 3.5"/>'),
    cloudy: s(cloud),
    partly: s('<path d="M8 4.5v1.2M3.8 6.3l.9.9M2.5 10.5h1.2M11.3 7.2l.9-.9"/><path d="M5.6 12.4A3.5 3.5 0 0 1 11.4 9"/><path d="M9 20h8.5a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 8.4 12.2 3.9 3.9 0 0 0 9 20Z"/>'),
    rain: s('<path d="M7 15h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 6.1 4.5 4.5 0 0 0 7 15Z"/><path d="M9 18l-1 2.5M13 18l-1 2.5M17 18l-1 2.5"/>'),
    snow: s('<path d="M7 15h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 6.1 4.5 4.5 0 0 0 7 15Z"/><path d="M9 19h.01M12 21h.01M15 19h.01M12 18h.01"/>'),
    plant: s('<path d="M12 21v-8"/><path d="M12 13c0-4 3-6.5 7-6.5 0 4-3 6.5-7 6.5Z"/><path d="M12 15c0-3-2.3-5-5.5-5 0 3 2.3 5 5.5 5Z"/><path d="M8 21h8"/>'),
    aurora: s('<path d="M3 18c3-6 6-9 9-9s6 3 9 9"/><path d="M6 15c2-3.5 4-5 6-5s4 1.5 6 5"/><path d="M12 3v2M5 6l1.2 1.2M19 6l-1.2 1.2"/>'),
    school: s('<path d="M4 6.5 12 3l8 3.5-8 3.5L4 6.5Z"/><path d="M7 8.5V14c0 1.7 2.2 3 5 3s5-1.3 5-3V8.5"/><path d="M20 6.5V12"/>'),
    menu: s('<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10"/><path d="M17 21V3c-2 1.5-3 4-3 7h3"/>'),
    leaf: s('<path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14Z"/><path d="M5 19l7-7"/>'),
    flag: s('<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>'),
    info: s('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>'),
    check: s('<circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.3l2.5 2.5 4.9-5.2"/>'),
    bell: s('<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
    cake: s('<path d="M4 20h16M5 20v-6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6"/><path d="M5 16c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 5 0"/><path d="M12 12V9M12 6.5c-.8-.8-.8-1.8 0-3 .8 1.2.8 2.2 0 3Z"/>'),
    sunrise: s('<path d="M12 3v5M9 6l3-3 3 3M4 18h16M7 18a5 5 0 0 1 10 0M3 14l1.5.8M21 14l-1.5.8"/>'),
    sunset: s('<path d="M12 8V3M9 5l3 3 3-3M4 18h16M7 18a5 5 0 0 1 10 0M3 14l1.5.8M21 14l-1.5.8"/>'),
    alarm: s('<circle cx="12" cy="13" r="7"/><path d="M12 9.5V13l2.5 1.5M5 3.5 2.5 6M19 3.5 21.5 6"/>'),
    calendar: s('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
    mic: s('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
    micOff: s('<path d="M15 9.5V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5M5.5 11a6.5 6.5 0 0 0 10.4 5.2M18.4 12.6a6.5 6.5 0 0 0 .1-1.6M12 17.5V21M3.5 3.5l17 17"/>'),
    keyboard: s('<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 13.5h.01M18 13.5h.01M8.5 14.5h7"/>'),
    bolt: s('<path d="M13 2.5 5 13.5h6l-1 8 8-11h-6l1-8Z"/>'),
    cart: s('<path d="M3 4h2.5l2.2 10.5h10.6L20.5 7H6.6"/><circle cx="9.5" cy="19" r="1.4"/><circle cx="17" cy="19" r="1.4"/>'),
    note: s('<path d="M5 3.5h10l4 4V20.5H5z"/><path d="M15 3.5v4h4M8.5 12h7M8.5 15.5h5"/>'),
    recycle: s('<path d="M7.5 8.5 10 4.5a2 2 0 0 1 3.4 0l2.1 3.5M18 11l2 3.5a2 2 0 0 1-1.7 3H14M9.5 17.5H5.7A2 2 0 0 1 4 14.5l1.8-3"/><path d="m14.5 6.5 1 1.5 1.8-.3M13.5 15.5l.5 2 -1.6 1.2M7 13l-1.2-1.5L4 12"/>'),
    timer: s('<circle cx="12" cy="13.5" r="7"/><path d="M12 10v3.5l2.3 1.6M9.5 2.5h5M12 2.5v4"/>'),
    warn: s('<path d="M12 3.5 2.5 20h19L12 3.5Z"/><path d="M12 10v4.5M12 17.2h.01"/>'),
    music: s('<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>'),
    home: s('<path d="M4 11 12 4l8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>'),
  };
})();
