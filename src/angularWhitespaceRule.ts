import * as Lint from 'tslint';
import * as ts from 'typescript';
import { NgWalker } from './angular/ngWalker';
import * as ast from '@angular/compiler';
import { BasicTemplateAstVisitor } from './angular/templates/basicTemplateAstVisitor';
import { ExpTypes } from './angular/expressionTypes';
import { Config } from './angular/config';
import { RecursiveAngularExpressionVisitor } from './angular/templates/recursiveAngularExpressionVisitor';

// Check if ES6 'y' flag is usable.
const stickyFlagUsable = (() => {
  try {
    const reg = new RegExp('\d', 'y');
    return true;
  } catch (e) {
    return false;
  }
})();

const InterpolationOpen = Config.interpolation[0];
const InterpolationClose = Config.interpolation[1];
const InterpolationWhitespaceRe = new RegExp(`${InterpolationOpen}(\\s*)(.*?)(\\s*)${InterpolationClose}`, 'g');
const SemicolonNoWhitespaceNotInSimpleQuoteRe = stickyFlagUsable ?
  new RegExp(`(?:[^';]|'[^']*'|;(?=\\s))+;(?=\\S)`, 'gy') : /(?:[^';]|'[^']*')+;/g;
const SemicolonNoWhitespaceNotInDoubleQuoteRe = stickyFlagUsable ?
  new RegExp(`(?:[^";]|"[^"]*"|;(?=\\s))+;(?=\\S)`, 'gy') : /(?:[^";]|"[^"]*")+;/g;


const getSemicolonReplacements = (absolutePosition: number) => {

  return [
    new Lint.Replacement(absolutePosition, 1, '; ')
  ];

};

interface CheckSemicolonNoWhitespaceMethod {
  (reg: RegExp, context: BasicTemplateAstVisitor, expr: string, fixedOffset: number): void;
}

// Simplify the code when the 'y' flag of RegExp is usable.
const checkSemicolonNoWhitespaceWithSticky: CheckSemicolonNoWhitespaceMethod = (reg, context, expr, fixedOffset) => {
  const error = 'Missing whitespace after semicolon; expecting \'; expr\'';
  let exprMatch: RegExpExecArray | null;

  while (exprMatch = reg.exec(expr)) {
    const start = fixedOffset + reg.lastIndex;
    const absolutePosition = context.getSourcePosition(start - 1);
    context.addFailure(context.createFailure(start, 2,
      error, getSemicolonReplacements(absolutePosition))
    );
  }
};

const checkSemicolonNoWhitespaceWithoutSticky: CheckSemicolonNoWhitespaceMethod = (reg, context, expr, fixedOffset) => {
  const error = 'Missing whitespace after semicolon; expecting \'; expr\'';
  let lastIndex = 0;
  let exprMatch: RegExpExecArray | null;

  while (exprMatch = reg.exec(expr)) {
    // When the 'y' flag of RegExp is unusable, must compare lastIndex with match.index,
    // otherwise the match results may be incorrect.
    if (lastIndex !== exprMatch.index) {
      break;
    }

    const nextIndex = reg.lastIndex;
    // Check if the character after the semicolon is not a whitespace.
    if (nextIndex < expr.length && /\S/.test(expr[nextIndex])) {
      const start = fixedOffset + nextIndex;
      const absolutePosition = context.getSourcePosition(start - 1);
      context.addFailure(context.createFailure(start, 2,
        error, getSemicolonReplacements(absolutePosition))
      );
    }

    lastIndex = nextIndex;
  }
};

const checkSemicolonNoWhitespace: CheckSemicolonNoWhitespaceMethod = stickyFlagUsable ?
  checkSemicolonNoWhitespaceWithSticky :
  checkSemicolonNoWhitespaceWithoutSticky;

type Option = 'check-interpolation' | 'check-pipe' | 'check-semicolon';

interface ConfigurableVisitor {
  getOption(): Option;
}

/* Interpolation visitors */

class InterpolationWhitespaceVisitor extends BasicTemplateAstVisitor implements ConfigurableVisitor {
  visitBoundText(text: ast.BoundTextAst, context: BasicTemplateAstVisitor): any {
    if (ExpTypes.ASTWithSource(text.value)) {
      // Note that will not be reliable for different interpolation symbols
      let error = null;
      const expr: any = (<any>text.value).source;
      const checkWhiteSpace = (subMatch: string, location: 'start' | 'end', fixTo: string,
        position: number, absolutePosition: number, lengthFix: number
      ) => {
        const { length } = subMatch;
        if (length === 1) {
            return;
        }
        const errorText = length === 0 ? 'Missing' : 'Extra';
        context.addFailure(context.createFailure(position, length + lengthFix,
          `${errorText} whitespace in interpolation ${location}; expecting ${InterpolationOpen} expr ${InterpolationClose}`, [
            new Lint.Replacement(absolutePosition, length + lengthFix, fixTo)
        ]));
      };

      InterpolationWhitespaceRe.lastIndex = 0;
      let match: RegExpExecArray | null;
      while (match = InterpolationWhitespaceRe.exec(expr)) {
        const start = text.sourceSpan.start.offset + match.index;
        const absolutePosition = context.getSourcePosition(start);

        checkWhiteSpace(match[1], 'start', `${InterpolationOpen} `, start, absolutePosition, InterpolationOpen.length);
        const positionFix = InterpolationOpen.length + match[1].length + match[2].length;
        checkWhiteSpace(match[3], 'end', ` ${InterpolationClose}`, start + positionFix, absolutePosition + positionFix,
          InterpolationClose.length);
      }
    }
    super.visitBoundText(text, context);
    return null;
  }

  getOption(): Option {
    return 'check-interpolation';
  }
}

class SemicolonTemplateVisitor extends BasicTemplateAstVisitor implements ConfigurableVisitor {

  visitDirectiveProperty(prop: ast.BoundDirectivePropertyAst, context: BasicTemplateAstVisitor): any {


    if (prop.sourceSpan) {
      const directive = (<any>prop.sourceSpan).toString();
      const match = /^([^=]+=\s*)([^]*?)\s*$/.exec(directive);
      const rawExpression = match[2];
      const positionFix = match[1].length + 1;
      const expr = rawExpression.slice(1, -1).trim();
      const doubleQuote = rawExpression[0] === '"';

      // Note that will not be reliable for different interpolation symbols
      let reg = doubleQuote ? SemicolonNoWhitespaceNotInSimpleQuoteRe : SemicolonNoWhitespaceNotInDoubleQuoteRe;
      reg.lastIndex = 0;
      checkSemicolonNoWhitespace(reg, context, expr, prop.sourceSpan.start.offset + positionFix);
    }
  }

  getOption(): Option {
    return 'check-semicolon';
  }

}


class WhitespaceTemplateVisitor extends BasicTemplateAstVisitor {
  private visitors: (BasicTemplateAstVisitor & ConfigurableVisitor)[] = [
    new InterpolationWhitespaceVisitor(this.getSourceFile(), this.getOptions(), this.context, this.templateStart),
    new SemicolonTemplateVisitor(this.getSourceFile(), this.getOptions(), this.context, this.templateStart)
  ];

  visitBoundText(text: ast.BoundTextAst, context: any): any {
    const options = this.getOptions();
    this.visitors
      .filter(v => options.indexOf(v.getOption()) >= 0)
      .map(v => v.visitBoundText(text, this))
      .filter(f => !!f)
      .forEach(f => this.addFailure(f));
    super.visitBoundText(text, context);
  }

  visitDirectiveProperty(prop: ast.BoundDirectivePropertyAst, context: any): any {
    const options = this.getOptions();
    this.visitors
      .filter(v => options.indexOf(v.getOption()) >= 0)
      .map(v => v.visitDirectiveProperty(prop, this))
      .filter(f => !!f)
      .forEach(f => this.addFailure(f));
    super.visitDirectiveProperty(prop, context);
  }


}


/* Expression visitors */

class PipeWhitespaceVisitor extends RecursiveAngularExpressionVisitor implements ConfigurableVisitor {
  visitPipe(ast: ast.BindingPipe, context: RecursiveAngularExpressionVisitor): any {

    let exprStart, exprEnd, exprText, sf;

    exprStart = context.getSourcePosition(ast.exp.span.start);
    exprEnd = context.getSourcePosition(ast.exp.span.end);
    sf = context.getSourceFile().getFullText();
    exprText = sf.substring(exprStart, exprEnd);


    const replacements = [];
    let parentheses = false;
    let leftBeginning: number;
    if (sf[exprEnd] === ')') {
      parentheses = true;
      leftBeginning = exprEnd + 1 + 2; // exprEnd === '|'
    } else {
      leftBeginning = exprEnd + 1; // exprEnd === '|'
    }

    // Handling the right side of the pipe
    if (sf[leftBeginning] === ' ') {
      let ignoreSpace = 1;
      while (sf[leftBeginning + ignoreSpace] === ' ') {
        ignoreSpace += 1;
      }
      if (ignoreSpace > 1) {
        replacements.push(new Lint.Replacement(exprEnd + 1, ignoreSpace, ' '));
      }
    } else {
      replacements.push(new Lint.Replacement(exprEnd + 1, 0, ' '));
    }

    // Handling the left side of the pipe
    if (exprText[exprText.length - 1] === ' ') {
      let ignoreSpace = 1;
      while (exprText[exprText.length - 1 - ignoreSpace] === ' ') {
        ignoreSpace += 1;
      }
      if (ignoreSpace > 1) {
        replacements.push(new Lint.Replacement(exprEnd - ignoreSpace, ignoreSpace, ' '));
      }
    } else {
      if (!parentheses) {
       replacements.push(new Lint.Replacement(exprEnd, 0, ' '));
      }
    }

    if (replacements.length) {
      context.addFailure(
        context.createFailure(ast.exp.span.end - 1, 3,
          'The pipe operator should be surrounded by one space on each side, i.e. " | ".',
          replacements)
      );
    }
    super.visitPipe(ast, context);
    return null;
  }

  getOption(): Option {
    return 'check-pipe';
  }

  protected isAsyncBinding(expr: any) {
    return expr instanceof ast.BindingPipe && expr.name === 'async';
  }
}


class TemplateExpressionVisitor extends RecursiveAngularExpressionVisitor {
  private visitors: (RecursiveAngularExpressionVisitor & ConfigurableVisitor)[] = [
    new PipeWhitespaceVisitor(this.getSourceFile(), this.getOptions(), this.context, this.basePosition)
  ];

  visitPipe(expr: ast.BindingPipe, context: any): any {
    const options = this.getOptions();
    this.visitors
      .map(v => v.addParentAST(this.parentAST))
      .filter(v => options.indexOf(v.getOption()) >= 0)
      .map(v => v.visitPipe(expr, this))
      .filter(f => !!f)
      .forEach(f => this.addFailure(f));
  }
}

export class Rule extends Lint.Rules.AbstractRule {
  public static metadata: Lint.IRuleMetadata = {
    ruleName: 'angular-whitespace',
    type: 'style',
    description: `Ensures the proper formatting of Angular expressions.`,
    rationale: `Having whitespace in the right places in an Angular expression makes the template more readable.`,
    optionsDescription: Lint.Utils.dedent`
      Arguments may be optionally provided:
      * \`"check-interpolation"\` checks for whitespace before and after the interpolation characters
      * \`"check-pipe"\` checks for whitespace before and after a pipe
      * \`"check-semicolon"\` checks for whitespace after semicolon`,
    options: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['check-interpolation', 'check-pipe', 'check-semicolon'],
      },
      minLength: 0,
      maxLength: 3,
    },
    optionExamples: ['[true, "check-interpolation"]'],
    typescriptOnly: true,
    hasFix: true
  };

  public apply(sourceFile: ts.SourceFile): Lint.RuleFailure[] {
    return this.applyWithWalker(
      new NgWalker(sourceFile,
        this.getOptions(), {
          templateVisitorCtrl: WhitespaceTemplateVisitor,
          expressionVisitorCtrl: TemplateExpressionVisitor,
        }));
  }
}
