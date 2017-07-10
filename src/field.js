import Generator from './generator';
import { uniqId, assign, normalizeRules, setDataAttribute, toggleClass, getInputEventName, debounce, isCallable, warn } from './utils';

const NULL_VALIDATOR = {
  validate: () => {}
};

const DEFAULT_OPTIONS = {
  scope: null,
  name: null,
  active: true,
  required: false,
  rules: {},
  vm: null,
  classes: false,
  events: 'input|blur',
  delay: 0,
  classNames: {
    touched: 'touched', // the control has been blurred
    untouched: 'untouched', // the control hasn't been blurred
    valid: 'valid', // model is valid
    invalid: 'invalid', // model is invalid
    pristine: 'pristine', // control has not been interacted with
    dirty: 'dirty' // control has been interacted with
  }
};

/**
 * Generates the default flags for the field.
 * @param {Object} options
 */
const generateFlags = (options) => ({
  untouched: true,
  touched: false,
  dirty: false,
  pristine: true,
  valid: null,
  invalid: null,
  validated: false,
  pending: false,
  required: !!options.rules.required
});

export default class Field {
  constructor (el, options = {}) {
    this.id = uniqId();
    this.el = el;
    this.expression = null;
    this.dependencies = [];
    this.watchers = [];
    this.events = [];
    if (!this.isHeadless) {
      setDataAttribute(this.el, 'id', this.id); // cache field id.
    }
    options = assign({}, DEFAULT_OPTIONS, options);
    this.flags = generateFlags(options);
    this.vm = options.vm || this.vm;
    this.component = options.component || this.component;
    this.update(options);
  }

  get isVue () {
    return !!this.component;
  }

  get validator () {
    if (this.vm) {
      return this.vm.$validator;
    }

    return NULL_VALIDATOR;
  }

  get isRequired () {
    return !!this.rules.required;
  }

  get isDisabled () {
    return (this.isVue && this.component.disabled) || (this.el && this.el.disabled);
  }

  get isHeadless () {
    return !this.el;
  }

  /**
   * Gets the display name (user-friendly name).
   * @return {String}
   */
  get displayName () {
    return this.alias;
  }

  /**
   * Gets the input value.
   * @return {*}
   */
  get value () {
    return this.getter();
  }

  /**
   * Determines if the instance matches the options provided.
   * @param {Object} options The matching options.
   */
  matches (options) {
    if (this.isDisabled) return false;

    if (options.id) {
      return this.id === options.id;
    }

    if (options.name === undefined && options.scope === undefined) {
      return true;
    }

    if (options.scope === undefined) {
      return this.name === options.name;
    }

    if (options.name === undefined) {
      return this.scope === options.scope;
    }

    return options.name === this.name && options.scope === this.scope;
  }

  /**
   *
   * @param {Object} options
   */
  update (options) {
    this.scope = options.scope || this.scope || null;
    this.name = options.name || this.name || null;
    this.rules = normalizeRules(options.rules || this.rules);
    this.model = options.model || this.model;
    this.classNames = options.classNames;
    this.expression = JSON.stringify(options.expression);
    this.alias = options.alias;
    this.getter = isCallable(options.getter) ? options.getter : this.getter;
    this.delay = options.delay || this.delay || 0;
    this.events = typeof options.events === 'string' && options.events.length ? options.events.split('|') : this.events;
    this.updateDependencies();

    // no need to continue.
    if (this.isHeadless) {
      this.classes = options.classes; // set it for consistency sake.
      return;
    };

    if (options.classes && !this.classes) {
      this.addClassListeners();
      this.updateClasses();
    } else if (this.classes) {
      // remove them.
      this.unwatch(/class/);
    }

    this.classes = options.classes;
    this.addValueListeners();
    this.updateAriaAttrs();
  }

  /**
   * Determines if the field requires references to target fields.
  */
  updateDependencies () {
    // reset dependencies.
    this.dependencies.forEach(field => {
      field.destroy();
    });
    this.dependencies = [];

    // we got the selectors for each field.
    const fields = Object.keys(this.rules).reduce((prev, r) => {
      if (r === 'confirmed') {
        prev.push({ selector: this.rules[r][0] || `${this.name}_confirmation`, name: r });
      }
      if (/after|before/.test(r)) {
        prev.push({ selector: this.rules[r][0], name: r });
      }

      return prev;
    }, []);

    if (!fields.length || !this.vm || !this.vm.$el) return;

    // must be contained within the same component, so we use the vm to search.
    fields.forEach(({ selector, name }) => {
      let el = null;
      // regular query selector.
      if (~['#', '.'].indexOf(selector[0])) {
        el = this.vm.$el.querySelector(selector);
      } else if (selector[0] === '$') {
        el = this.vm.$refs[selector.split('$').join('')];
      }

      if (!el) {
        return warn(`Could not find a field with this selector ${selector}.`);
      }

      let options = null;

      // probably a component.
      if (isCallable(el.$watch)) {
        options = Generator.generate(el.$el, {}, { context: this.vm });
        options.component = el;
        options.el = el.$el;
      } else {
        options = Generator.generate(el, {}, { context: this.vm });
        options.el = el;
      }

      // copy options.
      options.classes = this.classes;
      options.classNames = this.classNames;
      options.delay = this.delay;
      options.scope = this.scope;
      options.events = this.events;

      this.dependencies.push({ name, field: new Field(options.el, options) });
    });
  }

  /**
   * Removes listeners.
   * @param {RegExp} tag 
   */
  unwatch (tag) {
    this.watchers.filter(w => tag.test(w.tag)).forEach(w => w.unwatch());
    this.watchers = this.watchers.filter(w => !tag.test(w.tag));
  }

  /**
   * Updates the element classes depending on each field flag status.
   */
  updateClasses () {
    if (!this.classes) return;

    toggleClass(this.el, this.classNames.dirty, this.flags.dirty);
    toggleClass(this.el, this.classNames.pristine, this.flags.pristine);
    toggleClass(this.el, this.classNames.valid, !!this.flags.valid);
    toggleClass(this.el, this.classNames.invalid, !!this.flags.invalid);
    toggleClass(this.el, this.classNames.touched, this.flags.touched);
    toggleClass(this.el, this.classNames.untouched, this.flags.untouched);
  }

  /**
   * Adds the listeners required for automatic classes.
   */
  addClassListeners () {
    // remove previous listeners.
    this.unwatch(/class/);

    const onFocus = () => {
      toggleClass(this.el, this.classNames.touched, true);
      toggleClass(this.el, this.classNames.untouched, false);
      this.flags.touched = true;
      this.flags.untouched = false;

      // only needed once.
      this.unwatch(/^class_focus$/);
    };

    const event = getInputEventName(this.el);
    const onInput = () => {
      toggleClass(this.el, this.classNames.pristine, false);
      toggleClass(this.el, this.classNames.dirty, true);
      this.flags.dirty = true;
      this.flags.pristine = false;

      // only needed once.
      this.unwatch(/^class_input$/);
    };

    if (this.isVue) {
      this.component.$once('input', onInput);
      this.component.$once('focus', onFocus);
      this.watchers.push({
        tag: 'class_input',
        unwatch: () => {
          this.component.$off('input', onInput);
        }
      });
      this.watchers.push({
        tag: 'class_focus',
        unwatch: () => {
          this.component.$off('focus', onFocus);
        }
      });
      return;
    }
    this.el.addEventListener(event, onInput);
    this.el.addEventListener('focus', onFocus);
    this.watchers.push({
      tag: 'class_input',
      unwatch: () => {
        this.el.removeEventListener(event, onInput);
      }
    });
    this.watchers.push({
      tag: 'class_focus',
      unwatch: () => {
        this.el.removeEventListener('focus', onFocus);
      }
    });
  }

  /**
   * Adds the listeners required for validation.
   */
  addValueListeners () {
    this.unwatch(/^input_.+/);
    const validate = debounce(() => {
      this.validator.validate(`#${this.id}`, this.value);
    }, this.delay);

    const inputEvent = getInputEventName(this.el);
    // replace input event with suitable one.
    let events = this.events.map(e => {
      return e === 'input' ? inputEvent : e;
    });

    // if there is a watchable model and an on input validation is requested.
    if (this.model && events.indexOf(inputEvent) !== -1) {
      const unwatch = this.vm.$watch(this.model, validate);
      this.watchers.push({
        tag: 'input_model',
        unwatch
      });
      // filter out input event as it is already handled by the watcher API.
      events = events.filter(e => e !== inputEvent);
    }

    // Add events.
    events.forEach(e => {
      if (this.isVue) {
        this.component.$on(e, validate);
        this.watchers.push({
          tag: 'input_vue',
          unwatch: () => {
            this.component.$off(e, validate);
          }
        });
        return;
      }

      this.el.addEventListener(e, validate);
      this.watchers.push({
        tag: 'input_native',
        unwatch: () => {
          this.el.removeEventListener(e, validate);
        }
      });
    });
  }

  /**
   * Updates aria attributes on the element.
   */
  updateAriaAttrs () {
    if (this.isHeadless || !isCallable(this.el.setAttribute)) return;

    this.el.setAttribute('aria-required', this.isRequired ? 'true' : 'false');
    this.el.setAttribute('aria-invalid', this.flags.invalid ? 'true' : 'false');
  }

  /**
   * Removes all listeners.
   */
  destroy () {
    this.watchers.forEach(w => w.unwatch());
    this.watchers = [];
  }
}
