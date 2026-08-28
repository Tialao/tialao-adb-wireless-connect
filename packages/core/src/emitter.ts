/**
 * Mini-émetteur typé, à canal unique.
 *
 * Pourquoi pas `node:events` :
 *  - il n'est pas typé sans gymnastique de génériques ;
 *  - son canal `error` LÈVE si personne n'écoute, ce qui est inacceptable dans un flux
 *    long où l'abonné (un webview) peut disparaître à tout moment. Ici une erreur est
 *    une valeur de l'union comme une autre.
 *
 * Pourquoi pas un simple callback : il faut plusieurs abonnés simultanés (le webview,
 * le journal, la barre d'état). La forme `on(listener): Unsubscribe` est volontairement
 * isomorphe à `vscode.Event<T>`, ce qui évite tout adaptateur côté extension.
 */

export type Unsubscribe = () => void;
export type Listener<T> = (event: T) => void;

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  on(listener: Listener<T>): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Émission synchrone, dans l'ordre d'abonnement. Un abonné qui lève ne doit jamais
   * casser la machine à états ni empêcher les autres abonnés d'être notifiés.
   */
  emit(event: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Volontairement avalé : la santé du flux ne dépend pas de celle de l'UI.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }

  dispose(): void {
    this.listeners.clear();
  }
}
