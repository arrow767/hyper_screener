import { ContextFeatures } from './contextFeatures';
import { AnchorId, AnchorStats } from './anchorMemory';
import { config } from '../config';
import { PolicyRulesParser, PolicyRule, PolicyConfig } from './policyRules';

/**
 * Результат применения политики к позиции/сигналу.
 */
export interface PolicyDecision {
  allowTrade: boolean;           // Разрешена ли сделка
  sizeMultiplier: number;        // Множитель размера позиции
  tpNatrMultiplier: number;      // Множитель уровней TP в NATR
  slNatrMultiplier: number;      // Множитель уровней SL в NATR
  reason: string;                // Причина решения (для логов)
}

/**
 * Сервис для применения политик к сигналам и позициям.
 */
export class PositionPolicy {
  private rules: PolicyRule[] = [];
  
  constructor() {
    this.loadRulesFromYaml();
  }
  
  /**
   * Загрузить правила из YAML файла.
   */
  private loadRulesFromYaml(): void {
    const policyConfig = PolicyRulesParser.loadFromFile(config.policyRulesFile);
    this.rules = policyConfig.rules;
    
    console.log(`[PositionPolicy] Загружено ${this.rules.length} правил из ${config.policyRulesFile}`);
  }
  
  /**
   * Проверить, выполняются ли условия правила.
   */
  private checkConditions(rule: PolicyRule, features: ContextFeatures): boolean {
    const cond = rule.when;
    
    // shock30mNatr: >= и <=
    if (cond.shock30mNatrGte !== undefined && features.shock30mNatr < cond.shock30mNatrGte) {
      return false;
    }
    if (cond.shock30mNatrLte !== undefined && features.shock30mNatr > cond.shock30mNatrLte) {
      return false;
    }
    
    // shock60mNatr: >= и <=
    if (cond.shock60mNatrGte !== undefined && features.shock60mNatr < cond.shock60mNatrGte) {
      return false;
    }
    if (cond.shock60mNatrLte !== undefined && features.shock60mNatr > cond.shock60mNatrLte) {
      return false;
    }
    
    // anchorTradeCount: >= и <=
    if (cond.anchorTradeCountGte !== undefined && features.anchorTradeCount < cond.anchorTradeCountGte) {
      return false;
    }
    if (cond.anchorTradeCountLte !== undefined && features.anchorTradeCount > cond.anchorTradeCountLte) {
      return false;
    }
    
    // anchorWinCount: >= и <=
    if (cond.anchorWinCountGte !== undefined && features.anchorWinCount < cond.anchorWinCountGte) {
      return false;
    }
    if (cond.anchorWinCountLte !== undefined && features.anchorWinCount > cond.anchorWinCountLte) {
      return false;
    }
    
    // anchorLastTradeAgoMin: >= и <=
    if (cond.anchorLastTradeAgoMinGte !== undefined && features.anchorLastTradeAgoMin < cond.anchorLastTradeAgoMinGte) {
      return false;
    }
    if (cond.anchorLastTradeAgoMinLte !== undefined && features.anchorLastTradeAgoMin > cond.anchorLastTradeAgoMinLte) {
      return false;
    }
    
    // timeInAnchorZoneMin: >= и <=
    if (cond.timeInAnchorZoneMinGte !== undefined && features.timeInAnchorZoneMin < cond.timeInAnchorZoneMinGte) {
      return false;
    }
    if (cond.timeInAnchorZoneMinLte !== undefined && features.timeInAnchorZoneMin > cond.timeInAnchorZoneMinLte) {
      return false;
    }
    
    // tpHitsCount: ==
    if (cond.tpHitsCountEq !== undefined && features.tpHitsCount !== cond.tpHitsCountEq) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Применить политику к сигналу/позиции на основе фичей.
   */
  evaluatePolicy(features: ContextFeatures): PolicyDecision {
    // Базовое решение (по умолчанию)
    const decision: PolicyDecision = {
      allowTrade: true,
      sizeMultiplier: 1.0,
      tpNatrMultiplier: 1.0,
      slNatrMultiplier: 1.0,
      reason: 'default',
    };
    
    // Применяем правила по приоритету
    const appliedRules: string[] = [];
    
    for (const rule of this.rules) {
      if (this.checkConditions(rule, features)) {
        appliedRules.push(rule.name);
        
        // Применяем действия правила
        if (rule.then.allowTrade !== undefined) {
          decision.allowTrade = rule.then.allowTrade;
        }
        
        if (rule.then.sizeMultiplier !== undefined) {
          decision.sizeMultiplier *= rule.then.sizeMultiplier;
        }
        
        if (rule.then.tpNatrMultiplier !== undefined) {
          decision.tpNatrMultiplier *= rule.then.tpNatrMultiplier;
        }
        
        if (rule.then.slNatrMultiplier !== undefined) {
          decision.slNatrMultiplier *= rule.then.slNatrMultiplier;
        }
        
        // Если правило запрещает торговлю, останавливаемся
        if (decision.allowTrade === false) {
          decision.reason = rule.name;
          break;
        }
      }
    }
    
    if (appliedRules.length > 0) {
      decision.reason = appliedRules.join(', ');
    }
    
    return decision;
  }
  
  /**
   * Добавить кастомное правило.
   */
  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => a.priority - b.priority);
  }
  
  /**
   * Получить все правила (для отладки).
   */
  getRules(): PolicyRule[] {
    return [...this.rules];
  }
}

