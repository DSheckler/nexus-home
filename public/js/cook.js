// NEXUS Home - modo cocina: una receta paso a paso a pantalla completa.
// Se abre cuando el asistente prepara una receta ("vamos a cocinar tortilla de patatas").
// Se maneja tocando o por voz: "Oye NEXUS, siguiente", "anterior", "repite", "pon el
// temporizador", "ingredientes", "termina".
(function () {
  "use strict";

  let N = null;
  let recipe = null;   // { title, servings, ingredients: [], steps: [{ text, minutes }] }
  let idx = 0;
  let el = null;

  const say = (t) => { if (window.NexusVoice && t) window.NexusVoice.say(t); };
  const stepText = () => `Paso ${idx + 1}: ${recipe.steps[idx].text}`;

  function render() {
    if (!recipe) return;
    const s = recipe.steps[idx];
    const h = N.h;
    const btn = (label, cls, fn) => h("button", { class: "btn " + cls, type: "button", onclick: fn }, label);
    const box = h("div", { class: "cook" },
      h("header", { class: "cook-head" },
        h("div", {}, h("p", { class: "cook-title" }, recipe.title), h("p", { class: "cook-count" }, `Paso ${idx + 1} de ${recipe.steps.length}` + (recipe.servings ? ` · ${recipe.servings} personas` : ""))),
        btn("Salir", "ghost", () => end(true))),
      h("div", { class: "cook-bar" }, h("i", { style: `width:${((idx + 1) / recipe.steps.length) * 100}%` })),
      h("p", { class: "cook-step" }, s.text),
      s.minutes ? h("div", { class: "cook-timer" }, btn(`Poner temporizador de ${s.minutes} min`, "", () => command("timer"))) : null,
      h("p", { class: "cook-hint" }, "Por voz: «Oye NEXUS, siguiente», «anterior», «repite», «ingredientes» o «termina»."),
      h("footer", { class: "cook-foot" },
        btn("‹ Anterior", "ghost", () => command("prev")),
        btn("Ingredientes", "ghost", () => command("ingredients")),
        btn("Repetir", "ghost", () => command("repeat")),
        idx < recipe.steps.length - 1 ? btn("Siguiente ›", "primary", () => command("next")) : btn("¡Terminado!", "primary", () => end(true))));
    if (el) el.replaceWith(box); else document.body.append(box);
    el = box;
  }

  // silent: el asistente ya ha leído el primer paso en su respuesta
  function start(r, { silent } = {}) {
    if (!r || !r.steps || !r.steps.length) return;
    recipe = r; idx = 0;
    render();
    if (!silent) say(`${r.title}. ${stepText()}`);
  }

  async function command(cmd) {
    if (!recipe) return;
    if (cmd === "next") {
      if (idx < recipe.steps.length - 1) { idx++; render(); say(stepText()); }
      else say("Ese era el último paso. ¡Que aproveche!");
    } else if (cmd === "prev") {
      if (idx > 0) { idx--; render(); }
      say(stepText());
    } else if (cmd === "repeat") {
      say(stepText());
    } else if (cmd === "ingredients") {
      say(recipe.ingredients && recipe.ingredients.length ? "Ingredientes: " + recipe.ingredients.join(", ") + "." : "No tengo la lista de ingredientes de esta receta.");
    } else if (cmd === "timer") {
      const s = recipe.steps[idx];
      const min = s.minutes || 0;
      if (!min) return say("Este paso no tiene tiempo de espera. Dime cuántos minutos y lo pongo.");
      try {
        await N.api("/api/timers", { method: "POST", body: { seconds: min * 60, label: recipe.title.slice(0, 24) } });
        if (window.NexusHome) window.NexusHome.refresh();
        say(`Temporizador de ${min} ${min === 1 ? "minuto" : "minutos"} en marcha.`);
      } catch (e) { N.toast(e.message || "No se pudo poner el temporizador"); }
    } else if (cmd === "end") {
      end(true);
    }
  }

  function end(withVoice) {
    if (el) el.remove();
    el = null; recipe = null;
    if (withVoice) say("¡Que aproveche!");
  }

  function init(ctx) { N = ctx; }

  window.NexusCook = { init, start, command, end, active: () => !!recipe };
})();
