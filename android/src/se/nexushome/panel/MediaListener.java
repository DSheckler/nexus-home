package se.nexushome.panel;

import android.service.notification.NotificationListenerService;

/**
 * Servicio vacío: Android solo deja leer y controlar la música que suena en otras apps
 * (Spotify, YouTube...) a las apps con acceso a notificaciones. NEXUS no lee las notificaciones.
 */
public class MediaListener extends NotificationListenerService {
}
