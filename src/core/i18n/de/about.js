// Über WebSfM (AboutModal.vue), sein Versionsblock (VersionsPanel.vue) und die Abzeichen
// neben dem Namen der App (BetaBadge.vue).
export default {
  title: 'Über WebSfM',
  tagline: 'Structure from Motion im Browser · v{version}',
  tab: {
    about: 'Über',
    credits: 'Danksagungen',
    references: 'Quellen',
    licenses: 'Lizenzen',
  },
  lede:
    'Eine vollständige Photogrammetrie-Pipeline — Detektion, Matching, dünne und dichte Rekonstruktion, Mesh ' +
    'und Orthophotos —, die ganz in Ihrem Browser läuft. Kein Server, kein Upload: Ihre Bilder verlassen Ihren ' +
    'Rechner nie.',
  github: 'GitHub',
  reportBug: 'Fehler melden',
  mitLicense: 'MIT-Lizenz',
  creditsLede: 'WebSfM baut auf Jahrzehnten offener Forschung und Software auf. Seine Methoden stützen sich auf:',
  referencesLede:
    'Die veröffentlichten Methoden, die WebSfM umsetzt, jede mit den Glossareinträgen, die erklären, wofür sie ' +
    'dient. Jeder Glossareintrag nennt sie unter Quellen; der Qualitätsbericht nennt die, die ein Projekt verwendet hat.',
  usedFor: 'Verwendet für:',
  licensesLede:
    'WebSfM steht unter der MIT-Lizenz. Es enthält die Software, Modelle und Daten unten, die andere gemacht ' +
    'haben und die ihre eigenen Lizenzen behalten. Alle in einer Datei:',
  noticesFailed: 'Die Liste konnte nicht geladen werden. Sie liegt der App als THIRD_PARTY_NOTICES.txt bei.',
  tryAgain: 'Erneut versuchen',
  loading: 'Wird geladen…',
  licenseText: '{n, plural, one {Lizenztext} other {Lizenztexte (#)}}',
  versions: {
    heading: 'Version',
    newest: 'WebSfM {version}, die neueste Version. Sie aktualisiert sich selbst, wenn eine neue Version erscheint.',
    pinned:
      'WebSfM {version}, fixiert: Sie bleibt genau so, wenn WebSfM aktualisiert wird, sodass sich ein Ergebnis ' +
      'mit derselben Version wieder erzeugen lässt.',
    pinThis: '{version} weiter verwenden',
    pinThisTitle:
      'Öffnet {version} unter einer eigenen Adresse, die sich nie ändert. Als Lesezeichen speichern, um bei {version} zu bleiben.',
    openNewest: 'Neueste Version öffnen',
    others: 'Andere Versionen:',
    shared:
      'Alle Versionen teilen Ihre Projekte. Eine Version öffnet kein Projekt, das eine neuere geöffnet hat: ' +
      'Speichern könnte dort verlieren, was die neuere hinzugefügt hat.',
  },
  badge: {
    beta: 'Beta',
    betaTitle:
      'WebSfM ist in der Beta: Funktionen und das Projektformat ändern sich noch zwischen Versionen. Bewahren Sie Ihre Ausgangsbilder auf.',
    pinned: 'Fixiert',
    pinnedTitle:
      'WebSfM {version}, fixiert: Sie bleibt so, wenn WebSfM aktualisiert wird. „Über WebSfM“ zeigt die anderen Versionen.',
  },
}
