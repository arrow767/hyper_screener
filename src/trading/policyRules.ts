/**
 * Типы и парсер для YAML-правил контекстного управления позициями (Спринт 9)
 */

import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Область применения правила
 */
export type RuleScope = 'new_entry' | 'open_position' | 'new_entry_breakdown';

/**
 * Условия активации правила (when)
 * Все условия должны выполняться (логическое И)
 */
export interface RuleConditions {
  /**
   * Минимальный шок за 30 минут (в NATR)
   */
  shock30mNatrGte?: number;
  /**
   * Максимальный шок за 30 минут (в NATR)
   */
  shock30mNatrLte?: number;
  /**
   * Минимальный шок за 60 минут (в NATR)
   */
  shock60mNatrGte?: number;
  /**
   * Максимальный шок за 60 минут (в NATR)
   */
  shock60mNatrLte?: number;
  /**
   * Минимальное количество сделок по якорю
   */
  anchorTradeCountGte?: number;
  /**
   * Максимальное количество сделок по якорю
   */
  anchorTradeCountLte?: number;
  /**
   * Минимальное количество профитных сделок по якорю
   */
  anchorWinCountGte?: number;
  /**
   * Максимальное количество профитных сделок по якорю
   */
  anchorWinCountLte?: number;
  /**
   * Минимум минут с последней сделки по якорю
   */
  anchorLastTradeAgoMinGte?: number;
  /**
   * Максимум минут с последней сделки по якорю
   */
  anchorLastTradeAgoMinLte?: number;
  /**
   * Минимум минут в зоне якоря
   */
  timeInAnchorZoneMinGte?: number;
  /**
   * Максимум минут в зоне якоря
   */
  timeInAnchorZoneMinLte?: number;
  /**
   * Точное количество достигнутых TP
   */
  tpHitsCountEq?: number;
}

/**
 * Действия при активации правила (then)
 */
export interface RuleActions {
  /**
   * Разрешить/запретить торговлю
   */
  allowTrade?: boolean;
  /**
   * Множитель размера позиции
   */
  sizeMultiplier?: number;
  /**
   * Множитель уровней TP в NATR
   */
  tpNatrMultiplier?: number;
  /**
   * Множитель уровней SL в NATR
   */
  slNatrMultiplier?: number;
}

/**
 * Определение одного правила
 */
export interface PolicyRule {
  /**
   * Уникальное имя правила
   */
  name: string;
  /**
   * Приоритет (меньше = выше, правила применяются по порядку)
   */
  priority: number;
  /**
   * Область применения
   */
  scope: RuleScope;
  /**
   * Условия активации (все должны выполняться)
   */
  when: RuleConditions;
  /**
   * Действия при активации
   */
  then: RuleActions;
}

/**
 * Корневая структура YAML файла
 */
export interface PolicyConfig {
  rules: PolicyRule[];
}

/**
 * Парсер и валидатор YAML правил
 */
export class PolicyRulesParser {
  /**
   * Загружает и парсит YAML файл с правилами
   */
  static loadFromFile(filePath: string): PolicyConfig {
    const resolvedPath = path.resolve(filePath);
    
    if (!fs.existsSync(resolvedPath)) {
      console.warn(`[PolicyRulesParser] YAML файл не найден: ${resolvedPath}, используем пустой набор правил`);
      return { rules: [] };
    }

    try {
      const fileContents = fs.readFileSync(resolvedPath, 'utf8');
      const parsed = yaml.load(fileContents) as any;
      
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('YAML файл не содержит объект');
      }

      if (!Array.isArray(parsed.rules)) {
        throw new Error('Поле "rules" отсутствует или не является массивом');
      }

      const config: PolicyConfig = {
        rules: parsed.rules.map((rule: any, idx: number) => this.validateRule(rule, idx))
      };

      // Сортируем правила по приоритету
      config.rules.sort((a, b) => a.priority - b.priority);

      console.log(`[PolicyRulesParser] Загружено ${config.rules.length} правил из ${resolvedPath}`);
      return config;
    } catch (error: any) {
      console.error(`[PolicyRulesParser] Ошибка загрузки YAML: ${error.message}`);
      return { rules: [] };
    }
  }

  /**
   * Валидирует и преобразует правило
   */
  private static validateRule(rule: any, idx: number): PolicyRule {
    if (!rule || typeof rule !== 'object') {
      throw new Error(`Правило #${idx} не является объектом`);
    }

    if (!rule.name || typeof rule.name !== 'string') {
      throw new Error(`Правило #${idx}: отсутствует или некорректное поле "name"`);
    }

    if (typeof rule.priority !== 'number') {
      throw new Error(`Правило "${rule.name}": отсутствует или некорректное поле "priority"`);
    }

    if (!['new_entry', 'open_position', 'new_entry_breakdown'].includes(rule.scope)) {
      throw new Error(`Правило "${rule.name}": некорректное значение "scope" (должно быть: new_entry, open_position, new_entry_breakdown)`);
    }

    if (!rule.when || typeof rule.when !== 'object') {
      throw new Error(`Правило "${rule.name}": отсутствует или некорректное поле "when"`);
    }

    if (!rule.then || typeof rule.then !== 'object') {
      throw new Error(`Правило "${rule.name}": отсутствует или некорректное поле "then"`);
    }

    // Валидируем условия
    this.validateConditions(rule.when, rule.name);

    // Валидируем действия
    this.validateActions(rule.then, rule.name);

    return {
      name: rule.name,
      priority: rule.priority,
      scope: rule.scope as RuleScope,
      when: rule.when as RuleConditions,
      then: rule.then as RuleActions
    };
  }

  /**
   * Валидирует условия (when)
   */
  private static validateConditions(when: any, ruleName: string): void {
    const validKeys = [
      'shock30mNatrGte',
      'shock30mNatrLte',
      'shock60mNatrGte',
      'shock60mNatrLte',
      'anchorTradeCountGte',
      'anchorTradeCountLte',
      'anchorWinCountGte',
      'anchorWinCountLte',
      'anchorLastTradeAgoMinGte',
      'anchorLastTradeAgoMinLte',
      'timeInAnchorZoneMinGte',
      'timeInAnchorZoneMinLte',
      'tpHitsCountEq'
    ];

    for (const key of Object.keys(when)) {
      if (!validKeys.includes(key)) {
        throw new Error(`Правило "${ruleName}": неизвестное условие "${key}"`);
      }
      if (typeof when[key] !== 'number') {
        throw new Error(`Правило "${ruleName}": условие "${key}" должно быть числом`);
      }
    }

    if (Object.keys(when).length === 0) {
      throw new Error(`Правило "${ruleName}": блок "when" не содержит условий`);
    }
  }

  /**
   * Валидирует действия (then)
   */
  private static validateActions(then: any, ruleName: string): void {
    const validKeys = ['allowTrade', 'sizeMultiplier', 'tpNatrMultiplier', 'slNatrMultiplier'];

    for (const key of Object.keys(then)) {
      if (!validKeys.includes(key)) {
        throw new Error(`Правило "${ruleName}": неизвестное действие "${key}"`);
      }

      if (key === 'allowTrade') {
        if (typeof then[key] !== 'boolean') {
          throw new Error(`Правило "${ruleName}": действие "allowTrade" должно быть boolean`);
        }
      } else {
        if (typeof then[key] !== 'number') {
          throw new Error(`Правило "${ruleName}": действие "${key}" должно быть числом`);
        }
      }
    }

    if (Object.keys(then).length === 0) {
      throw new Error(`Правило "${ruleName}": блок "then" не содержит действий`);
    }
  }
}

