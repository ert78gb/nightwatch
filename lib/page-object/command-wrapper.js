const Element = require('../element');
const Utils = require('../utils');

const ALLOWED_NAMESPACES = [
  'alerts', 'cookies', 'document',
  'assert', 'verify', 'expect'
];

function isAllowedNamespace(commandName) {
  return ALLOWED_NAMESPACES.indexOf(commandName) > -1;
}

class Command {
  static get TYPE_ELEMENT() {
    return 'element';
  }

  static get TYPE_SECTION() {
    return 'section';
  }

  static isPossibleElementSelector(item, commandName = '') {
    if (!item) {
      return false;
    }

    if (Array.isArray(item)) {
      return false;
    }

    if (Utils.isObject(item)) {
      /*eslint no-prototype-builtins: 'warn'*/
      return item.hasOwnProperty('selector') && Utils.isString(item.selector);
    }

    const Api = require('../api');
    const ScopedElementApi = require('../api/_loaders/element-api');

    return Utils.isString(item) && (item.startsWith('@') || Api.isElementCommand(commandName) || ScopedElementApi.isScopedElementCommand(commandName));
  }

  static isUserDefinedElementCommand(commandName) {
    const ApiLoader = require('../api');

    return !ApiLoader.getElementsCommandsStrict().includes(commandName);
  }

  constructor(parent, commandName, isChaiAssertion, isES6Async = false) {
    this.parent = parent;
    this.commandName = commandName;
    this.isChaiAssertion = isChaiAssertion;
    this.isES6Async = isES6Async;
    this.isUserDefined = Command.isUserDefinedElementCommand(commandName);
  }

  /**
   * Creates a closure that enables calling commands and assertions on the page or section.
   * For all element commands and assertions, it fetches element's selector and locate strategy
   *  For elements nested under sections, it sets 'recursion' as the locate strategy and passes as its first argument to the command an array of its ancestors + self
   *  If the command or assertion is not on an element, it calls it with the untouched passed arguments
   *
   * @param {function} commandFn The actual command function
   * @returns {function}
   */
  createWrapper(commandFn) {
    const self = this;

    return function (...args) {

      if (args.length > 0 && this.__needsRecursion) {
        // within commands
        const inputElement = Element.createFromSelector(args[0]);

        if (self.isUserDefined) {
          inputElement.container = this.__element;
          args[0] = inputElement;
        } else {
          args[0] = Element.createFromSelector({
            locateStrategy: 'recursion',
            selector: [this.__element, inputElement]
          });
        }
      }

      const client = this.client || self.parent && self.parent.client || {};
      const result = self.executeCommand(commandFn, args, client);

      if (self.isChaiAssertion) {
        return result;
      }

      const {isES6AsyncTestcase} = client;

      if ((result instanceof Promise) && (self.parent.constructor.name === 'Page' || isES6AsyncTestcase)) {
        // when isES6AsyncTestcase is true, all page and section commands reach here (all commands
        // return a Promise by default when isES6AsyncTestcase is true).
        // when isES6AsyncTestcase is false, only those page commands which return promise reach here
        // (normal API commands do not return Promise when isES6AsyncTestcase is false).

        Object.assign(result, self.parent);

        // Add parent prototype methods (like api, client, etc.) to result
        const parentPrototype = Object.getPrototypeOf(self.parent);
        Object.getOwnPropertyNames(parentPrototype).forEach((propertyName) => {
          if (propertyName === 'constructor') {
            return;
          }
          const propertyDescriptor = Object.getOwnPropertyDescriptor(parentPrototype, propertyName);
          Object.defineProperty(result, propertyName, propertyDescriptor);
        });

        return result;
      }

      return self.parent;
    };
  }

  validate(elementOrSection, strategy, type) {
    let target = null;
    let available = null;
    let typeAvailable = 'elements';
    let prefix;
    let showStrategy = '';
    let showAvailable;

    switch (type) {
      case Command.TYPE_ELEMENT:
        target = available = this.parent.elements;
        prefix = 'Element';
        break;
      case Command.TYPE_SECTION:
        target = available = this.parent.section;
        typeAvailable = 'sections';
        prefix = 'Section';
        break;
    }

    let isValid = false;
    if (elementOrSection in target) {
      isValid = true;
    }

    if (isValid && strategy) {
      isValid = target[elementOrSection].locateStrategy && target[elementOrSection].locateStrategy === strategy;
    }

    if (!isValid) {
      showAvailable = Object.keys(available);
      if (strategy) {
        showStrategy = `[locateStrategy='${strategy}']`;
        showAvailable = showAvailable.map(item => `${item}[locateStrategy='${target[item].locateStrategy}']`);
      }

      throw new Error(`${prefix} "${elementOrSection}${showStrategy}" was not found in "${this.parent.name}". Available ${typeAvailable}: ${showAvailable.join(', ')}`);
    }
  }

  /**
   * Given an element name, returns that element object
   *
   * @param {string} elementName Name of element
   * @param {string} [strategy]
   * @returns {Element} The element object
   */
  getElement(elementName, strategy = null) {
    this.validate(elementName, strategy, Command.TYPE_ELEMENT);

    return this.parent.elements[elementName];
  }

  /**
   * Given a section name, returns that section object
   *
   * @param {string} sectionName Name of section
   * @param {string} [strategy]
   * @returns {Element} The section object
   */
  getSection(sectionName, strategy = null) {
    this.validate(sectionName, strategy, Command.TYPE_SECTION);

    return this.parent.section[sectionName];
  }

  getSelectorFromArgs(args) {
    let selectorArg = args[0];

    const isSelector = Command.isPossibleElementSelector(selectorArg, this.commandName);
    if (isSelector) {
      // check if both strategy and selector are specified as args
      const {LocateStrategy} = Utils;
      const isStrategySpecified = LocateStrategy.isValid(selectorArg);
      if (isStrategySpecified && Utils.isString(args[1])) {
        selectorArg = {
          selector: args[1],
          locateStrategy: args[0]
        };
      }

      return selectorArg;
    }

    return null;
  }

  /**
   * Identifies element references (@-prefixed selectors) within an argument
   * list and converts it into an element object with the appropriate
   * selector or recursion chain of selectors.
   *
   * @param {Array} args The argument list to check for an element selector.
   */
  parseElementSelector(args) {
    const selector = this.getSelectorFromArgs(args);

    if (!selector) {
      return;
    }

    // currently only support first argument for @-elements
    let inputElement = Element.createFromSelector(selector);

    if (inputElement.hasElementSelector()) {
      const nameSections = inputElement.selector.substring(1).split(':');
      const name = nameSections[0];
      const pseudoSelector = nameSections[1] || null;

      // When true, indicates that the selector references a selector within a section rather than an elements definition.
      // eg: .expect.section('@footer').to.be.visible
      const isSectionSelector = this.isChaiAssertion && this.commandName === 'section';

      const getter = isSectionSelector ? this.getSection : this.getElement;

      const strategy = Utils.isObject(selector) && selector.locateStrategy || null;
      const elementOrSection = getter.call(this, name, strategy);
      elementOrSection.pseudoSelector = pseudoSelector;

      Element.copyDefaults(inputElement, elementOrSection);
      inputElement.locateStrategy = elementOrSection.locateStrategy;
      inputElement.selector = elementOrSection.selector; // force replacement of @-selector
      inputElement = inputElement.getRecursiveLookupElement() || inputElement;
      args[0] = inputElement;
    } else {
      // if we're calling an element on a section using a css/xpath selector,
      //  then we need to retrieve the element using recursion
      const Section = require('./section.js');
      if (this.parent instanceof Section) {
        inputElement.parent = this.parent;
        inputElement = inputElement.getRecursiveLookupElement() || Element.createFromSelector({
          locateStrategy: 'recursion',
          selector: [this.parent, inputElement]
        });

        const ScopedElementApi = require('../api/_loaders/element-api');
        if (ScopedElementApi.isScopedElementCommand(this.commandName)) {
          // only locate the parent sections recursively and then find the main element using
          // original method and arguments.
          this.onlyLocateSectionsRecursively = true;
        }

        args[0] = inputElement;
      }
    }
  }

  /**
   * @param {Function} commandFn
   * @param {Array} args
   * @param {Object} context
   */
  executeCommand(commandFn, args, context) {
    let parseArgs;
    if (Utils.isObject(args[0]) && Array.isArray(args[0].args)) {
      parseArgs = args[0].args;
    } else {
      parseArgs = args;
    }

    this.parseElementSelector(parseArgs);

    return commandFn.apply(context, args);
  }
}

class CommandLoader {

  /**
   * Entry point to add commands (elements commands, assertions, etc) to the page or section
   *
   * @param {Object} parent The parent page or section
   * @param {function} commandLoader function that retrieves commands
   * @returns {null}
   */
  static addWrappedCommands(parent, commandLoader) {
    const commands = {
      get '__pageObjectItem__' () {
        return parent;
      }
    };

    const wrappedCommands = commandLoader(commands);

    CommandLoader.applyCommandsToTarget(parent, parent, wrappedCommands);
    if (parent.assert && parent.verify) {
      const ApiLoader = require('../api');
      parent.assert = ApiLoader.makeAssertProxy(parent.assert);
      parent.verify = ApiLoader.makeAssertProxy(parent.verify);
    }
  }

  static addWrappedCommandsAsync(parent, commandLoader) {
    const commands = {};

    const wrappedCommands = commandLoader(commands);
    CommandLoader.applyCommandsToTarget(parent, parent, wrappedCommands);

    return wrappedCommands;
  }

  /**
   * Adds commands (elements commands, assertions, etc) to the page or section
   *
   * @param {Object} parent The parent page or section
   * @param {Object} target What the command is added to (parent|section or assertion object on parent|section)
   * @param {Object} commands
   * @returns {null}
   */
  static applyCommandsToTarget(parent, target, commands) {
    Object.keys(commands).forEach(function(commandName) {
      if (isAllowedNamespace(commandName)) {
        target[commandName] = target[commandName] || {};

        const isChaiAssertion = commandName === 'expect';
        const namespace = commands[commandName];

        Object.keys(namespace).forEach(function(nsCommandName) {
          target[commandName][nsCommandName] = CommandLoader.addCommand({
            target: target[commandName],
            commandFn: namespace[nsCommandName],
            commandName: nsCommandName,
            parent,
            isChaiAssertion
          });
        });
      } else {
        // don't load namespaces here, otherwise they'll be wrapped by a function.
        if (Utils.isObject(commands[commandName])) {
          return;
        }

        target[commandName] = CommandLoader.addCommand({
          target,
          commandFn: commands[commandName],
          commandName,
          parent,
          isChaiAssertion: false,
          isES6Async: Utils.isES6AsyncFn(commands[commandName])
        });
      }
    });
  }

  /**
   * @param parent
   * @param originalApi
   * @param targetApi
   * @param {string} commandName
   * @returns {function}
   */
  static wrapElementCommand(parent, originalApi, targetApi, commandName) {
    const originalFn = originalApi[commandName];

    const command = new Command(parent, commandName, false);

    return function(...args) {
      const origArgs = args.slice();

      command.parseElementSelector(args);

      if (command.onlyLocateSectionsRecursively) {
        // only happens in case of new scoped element api, when non @-referenced selector is passed
        // to element api methods for sections. Doing this is not really necessary for `find` and `findAll`
        // methods but only for testing-library methods (which only accepts string as first argument),
        // but we do it for them anyways.

        // transfer n-1 selectors to `element()` and the main selector (origArgs) to the actual method.
        args[0].selector.pop();

        const parentSectionElement = targetApi(args[0]);

        return parentSectionElement[commandName](...origArgs);
      }

      return originalFn.apply(targetApi, args);
    }; 
  }

  /**
   * @param parent
   * @param api
   * @param {Array} commands
   */
  static wrapProtocolCommands(parent, api, commands) {
    commands.forEach(commandName => {
      api[commandName] = CommandLoader.wrapElementCommand(parent, api, api, commandName);
    });
  }

  static wrapScopedElementApi(parent, api, elementCommands) {
    const wrappedElementFn = CommandLoader.wrapElementCommand(parent, api, api, 'element');

    elementCommands.forEach(commandName => {
      let names = commandName;
      if (!Array.isArray(names)) {
        names = [names];
      }

      names.forEach(commandName => {
        wrappedElementFn[commandName] = CommandLoader.wrapElementCommand(parent, api.element, wrappedElementFn, commandName);
      });
    });

    api.element = wrappedElementFn;
  }

  static addCommand({target, commandFn, commandName, parent, isChaiAssertion, isES6Async = false, overwrite = false}) {
    if (target[commandName] && !overwrite) {
      const err = new TypeError(`Error while loading the page object commands: the command "${commandName}" is already defined.`);
      err.displayed = false;
      err.showTrace = false;

      throw err;
    }

    const command = new Command(parent, commandName, isChaiAssertion, isES6Async);

    return command.createWrapper(commandFn);
  }
}

module.exports = CommandLoader;
