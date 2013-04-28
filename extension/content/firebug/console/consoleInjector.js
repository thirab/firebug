/* See license.txt for terms of usage */

define([
    "firebug/lib/object",
    "firebug/firebug",
    "firebug/chrome/reps",
    "firebug/lib/locale",
    "firebug/lib/events",
    "firebug/lib/url",
    "firebug/js/stackFrame",
    "firebug/chrome/window",
    "firebug/console/console",
    "firebug/lib/array",
    "firebug/lib/dom",
    "firebug/console/consoleExposed",
    "firebug/console/errors",
],
function(Obj, Firebug, FirebugReps, Locale, Events, Url, StackFrame, Win, Console, Arr, Dom) {

// ********************************************************************************************* //
// Constants

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

var exposedConsoleInstanceMap = new WeakMap();

// ********************************************************************************************* //
// Console Injector

Firebug.Console.injector =
{
    isAttached: function(context, win)
    {
        var handler = this.getConsoleHandler(context, win);

        if (FBTrace.DBG_CONSOLE)
            FBTrace.sysout("Console.isAttached "+handler+" in context "+context.getName()+
                " and win "+Win.safeGetWindowLocation(win), handler);

        return handler;
    },

    attachIfNeeded: function(context, win)
    {
        if (this.isAttached(context, win))
            return true;

        if (FBTrace.DBG_CONSOLE)
            FBTrace.sysout("Console.attachIfNeeded found isAttached false " +
                Win.safeGetWindowLocation(win));

        this.attachConsoleInjector(context, win);
        this.addConsoleListener(context, win);

        Firebug.Console.clearReloadWarning(context);

        var attached =  this.isAttached(context, win);
        if (attached)
            Events.dispatch(Firebug.Console.fbListeners, "onConsoleInjected", [context, win]);

        return attached;
    },

    attachConsoleInjector: function(context, win)
    {
        // Get the 'console' object (this comes from chrome scope).
        // console's methods return undefined by default.
        var console = Firebug.ConsoleExposed.createFirebugConsole(context, win, undefined, true);

        // Do not expose the chrome object as is but, rather do a wrapper, see below.
        // xxxFlorent: I could not reproduce the error described in issue 4493. Do you?
        win.wrappedJSObject.console = console;
        exposedConsoleInstanceMap.set(win.document, console);
        return;
    },

    getExposedConsoleInstance: function(win)
    {
        return exposedConsoleInstanceMap.get(win.document);
    },

    addConsoleListener: function(context, win)
    {
        if (!win)
            win = context.window;

        var handler = this.getConsoleHandler(context, win);
        if (handler)
            return;

        var handler = createConsoleHandler(context, win);

        // Initialize Firebug token
        Dom.setMappedData(win.document, "firebug-Token", handler.token);

        this.setConsoleHandler(context, win, handler);

        return true;
    },

    getConsoleHandler: function(context, win)
    {
        if (!win.document)
        {
            if (FBTrace.DBG_ERRORS)
            {
                FBTrace.sysout("console.getConsoleHandler; NO DOCUMENT",
                    {win:win, context:context});
            }
            return null;
        }

        var attachedToken = Dom.getMappedData(win.document, "firebug-Token");
        if (context.activeConsoleHandlers)
        {
            for(var i = 0; i < context.activeConsoleHandlers.length; i++)
            {
                if (context.activeConsoleHandlers[i].token === attachedToken)
                    return context.activeConsoleHandlers[i];
            }
        }
    },

    removeConsoleHandler: function(context, win)
    {
        var handler = this.getConsoleHandler(context, win);
        if (handler)
        {
            handler.detach();
            Arr.remove(context.activeConsoleHandlers, handler);

            if (FBTrace.DBG_CONSOLE)
                FBTrace.sysout("consoleInjector.removeConsoleHandler; token " + handler.token +
                    " and  attached handler("+handler.handler_name+") to _firebugConsole in : "+
                    Win.safeGetWindowLocation(win));
        }
    },

    setConsoleHandler: function(context, win, handler)
    {
        if (!context.activeConsoleHandlers)
            context.activeConsoleHandlers = [];

        context.activeConsoleHandlers.push(handler);

        if (FBTrace.DBG_CONSOLE)
            FBTrace.sysout("consoleInjector addConsoleListener set token "+handler.token+
                " and  attached handler("+handler.handler_name+") to _firebugConsole in : "+
                Win.safeGetWindowLocation(win));
    },

    detachConsole: function(context, win)
    {
        if (!win)
            win = context.window;

        this.removeConsoleHandler(context, win);
    }
};

// ********************************************************************************************* //

var total_handlers = 0;
function createConsoleHandler(context, win)
{
    var handler = {};
    // console's methods return undefined by default.
    handler.console = Firebug.ConsoleExposed.createFirebugConsole(context, win, undefined, true);

    // xxxHonza: these two functions should be automatically overridden, check this out
    // can be probably removed (evaluated and evaluateError).
    console.evaluated = function(result, context)
    {
        if (FBTrace.DBG_CONSOLE)
        {
            FBTrace.sysout("consoleInjector.FirebugConsoleHandler evaluated default called",
                result);
        }

        Firebug.Console.log(result, context);
    };

    console.evaluateError = function(result, context)
    {
        Firebug.Console.log(result, context, "errorMessage");
    };

    handler.detach = function()
    {
        Events.removeEventListener(win.document, 'firebugAppendConsole', this.boundHandler, true);

        if (FBTrace.DBG_CONSOLE)
            FBTrace.sysout("consoleInjector FirebugConsoleHandler removeEventListener "+
                this.handler_name);
    };

    handler.handler_name = ++total_handlers;
    handler.token = Math.random();

    handler.handleEvent = function(event)
    {
        if (FBTrace.DBG_CONSOLE)
            FBTrace.sysout("FirebugConsoleHandler(" + this.handler_name + ") " +
                Dom.getMappedData(win.document, "firebug-methodName") + ", event", event);
    };

    handler.setEvaluatedCallback = function( fnOfResult )
    {
        this.console.evaluated = fnOfResult;
    };

    handler.setEvaluateErrorCallback = function( fnOfResultAndContext )
    {
        this.console.evaluateError = fnOfResultAndContext;
    };

    handler.win = win;
    handler.context = context;

    // When raised on our injected element, callback to Firebug and append to console
    handler.boundHandler = Obj.bind(handler.handleEvent, handler);

    // capturing
    Events.addEventListener(win.document, "firebugAppendConsole", handler.boundHandler, true);

    if (FBTrace.DBG_CONSOLE)
        FBTrace.sysout("consoleInjector FirebugConsoleHandler addEventListener " +
            handler.handler_name);

    return handler;
}

// ********************************************************************************************* //
// Registration

return Firebug.Console.injector;

// ********************************************************************************************* //
});
